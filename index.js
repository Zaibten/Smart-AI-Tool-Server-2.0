const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require('path');
const fetch = require('node-fetch');

const nodemailer = require("nodemailer");
const cors = require("cors");
const algoliasearch = require("algoliasearch");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  'https://smartaitools.vercel.app',
  'https://www.selectaitool.com',
  'https://selectaitool.com',
  'http://localhost:4028'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// MongoDB Connection
const mongoURI = process.env.MONGO_URI;

mongoose
  .connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected Successfully"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));


// =========================
//  Algolia Configuration
// =========================
console.log("✅ Algolia App ID:", process.env.ALGOLIA_APP_ID);
console.log("✅ Algolia API Key:", process.env.ALGOLIA_ADMIN_API_KEY ? "Loaded" : "Missing");
console.log("✅ Algolia Index:", process.env.ALGOLIA_INDEX_NAME);

const client = algoliasearch(
  process.env.ALGOLIA_APP_ID,
  process.env.ALGOLIA_ADMIN_API_KEY
);
const index = client.initIndex(process.env.ALGOLIA_INDEX_NAME);


// Tool Schema
const toolSchema = new mongoose.Schema(
  {
    name: String,
    description: String,
    category: String,
    link: String,
    rating: Number,
    pricing: String,
    official_link: String,
    availability: String,
    details: String,
    profession: [String],
    tags: [String],
    new_description: String,
    image_url: String,
    date: String,
  },
  { collection: "tools" }
);

const Tool = mongoose.model("Tool", toolSchema);

// API: Get all tools
app.get("/api/tools", async (req, res) => {
  try {
    const tools = await Tool.find();
    const formattedTools = tools.map((tool) => ({
      ...tool._doc,
      profession: tool.profession ? tool.profession.slice(0, 2) : [],
      tags: tool.tags ? tool.tags.slice(0, 5) : [],
      rating: generateRandomRating(),
    }));
    res.json(formattedTools);
  } catch (error) {
    res.status(500).json({ error: "Error fetching tools" });
  }
});

app.get("/api/filters", async (req, res) => {
  try {
    const categories = await Tool.distinct("category");
    const allTools = await Tool.find({}, { profession: 1 });
    const professionSet = new Set();
    allTools.forEach(tool => {
      if (Array.isArray(tool.profession)) {
        tool.profession.forEach(p => professionSet.add(p));
      }
    });
    const professions = Array.from(professionSet);
    res.json({ categories, professions });
  } catch (err) {
    console.error("Error fetching filters:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/tools/filter", async (req, res) => {
  const { categories, professions, featured, pricing } = req.body;
  let filter = {};
  if (categories && categories.length) filter.category = { $in: categories };
  if (professions && professions.length) filter.profession = { $in: professions };
  if (featured) filter.featured = true;
  if (pricing) filter.pricing = pricing;
  try {
    const tools = await Tool.find(filter);
    res.json(tools);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch tools" });
  }
});

app.get("/api/tools/count", async (req, res) => {
  try {
    const totalTools = await Tool.countDocuments();
    res.json({ total: totalTools });
  } catch (error) {
    console.error("Error counting tools:", error);
    res.status(500).json({ error: "Failed to count tools" });
  }
});

// =========================
//  Algolia Sync — IMPORTANT: call this once after deploy
//  to push your Algolia index settings too!
// =========================
app.get("/api/sync-algolia", async (req, res) => {
  try {
    const tools = await Tool.find();

    const formatted = tools.map((tool) => ({
      objectID: tool._id.toString(),
      name: tool.name,
      description: tool.description,
      category: tool.category,
      pricing: tool.pricing,
      profession: tool.profession,
      tags: tool.tags,
      new_description: tool.new_description,
      link: tool.link,
      image_url: tool.image_url,
    }));

    await index.saveObjects(formatted);

    // ✅ Push index settings — this is what makes fuzzy/typo search work properly
    await index.setSettings({
      // Which fields Algolia searches
      searchableAttributes: [
        "name",                  // highest priority
        "category",
        "tags",
        "profession",
        "description",
        "new_description",       // lowest priority
      ],

      // ✅ Typo tolerance — the KEY fix for "mache" → "machine"
      typoTolerance: true,
      minWordSizefor1Typo: 3,    // "mac" (3 chars) can already get 1 typo fix
      minWordSizefor2Typos: 6,   // "machin" (6 chars) can get 2 typo fixes → "machinnnes"
      allowTyposOnNumericTokens: false,

      // ✅ Prefix matching on the LAST word only (much better than prefixAll)
      // prefixLast = treat the last typed word as a prefix → "mach" matches "machine"
      // prefixAll is too greedy and often breaks relevance
      queryType: "prefixLast",

      // ✅ If no results found with all words, drop optional words one by one
      removeWordsIfNoResults: "lastWords",

      // ✅ Treat plural/singular as same: "machines" = "machine"
      ignorePlurals: true,

      // ✅ This is the magic for "mache" → "machine":
      // Algolia will try adding/removing/swapping letters — allow it globally
      typoTolerance: "true",

      // ✅ Advanced: treat typos in the name field with lower penalty
      customRanking: ["desc(name)"],

      // Ranking: typo → geo → words → filters → proximity → attribute → exact → custom
      ranking: [
        "typo",
        "geo",
        "words",
        "filters",
        "proximity",
        "attribute",
        "exact",
        "custom",
      ],

      // ✅ Return these fields from Algolia
      attributesToRetrieve: [
        "objectID", "name", "description", "category",
        "pricing", "link", "image_url", "tags", "profession", "new_description"
      ],

      // ✅ Highlight matched text (useful for frontend bold highlights)
      attributesToHighlight: ["name", "category", "tags"],
    });

    res.json({ success: true, message: "✅ Tools synced to Algolia + settings updated!" });
  } catch (err) {
    console.error("Algolia sync error:", err);
    res.status(500).json({ error: "Failed to sync data with Algolia" });
  }
});


// =========================
//  NEXT-LEVEL SEARCH
//  Handles: "mache" → machine, "machinnnes" → machine learning
// =========================
app.get("/api/searchtools", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  const query = q.toLowerCase().trim();
  const words = query.split(/\s+/).filter(Boolean);

  try {
    // ============================================================
    //  PASS 1: Algolia — fuzzy + typo-tolerant + prefix search
    //  "mache" works because: minWordSizefor1Typo=3 allows 1 typo
    //  on a 5-char word. Algolia sees "mache" and tries swaps →
    //  finds "machine". "machinnnes" gets 2 typos → "machines".
    // ============================================================
    const algoliaResult = await index.search(query, {
      typoTolerance: true,
      minWordSizefor1Typo: 3,          // allow typo fix from 3 chars onwards
      minWordSizefor2Typos: 6,         // allow 2 typo fixes from 6 chars
      hitsPerPage: 50,
      ignorePlurals: true,
      removeWordsIfNoResults: "lastWords",  // drop last word if no hits
      queryType: "prefixLast",              // last word is treated as prefix
      attributesToRetrieve: [
        "objectID", "name", "description", "category",
        "pricing", "link", "image_url", "tags", "profession", "new_description"
      ],
    });

    const hits = algoliaResult.hits;
    const algoliaIds = new Set(hits.map((h) => String(h.objectID)));

    // ============================================================
    //  PASS 2: MongoDB substring fallback
    //  Catches anything Algolia missed (exact substring like "mach")
    // ============================================================
    const mongoOrClauses = words.flatMap((word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "i");
      return [
        { name: re },
        { description: re },
        { new_description: re },
        { category: re },
        { tags: re },
        { profession: re },
      ];
    });

    const mongoResults = await Tool.find({ $or: mongoOrClauses }).limit(30);

    const mongoExtras = mongoResults
      .filter((t) => !algoliaIds.has(String(t._id)))
      .map((t) => ({
        objectID: t._id,
        name: t.name,
        description: t.description,
        new_description: t.new_description,
        category: t.category,
        pricing: t.pricing,
        link: t.link,
        image_url: t.image_url,
        tags: t.tags,
        profession: t.profession,
        _fromMongo: true,
      }));

    const combined = [...hits, ...mongoExtras];

    // ============================================================
    //  PASS 3: Score & rank
    //  Algolia hits already have _rankingInfo but we re-score
    //  to boost exact/prefix name matches to the top
    // ============================================================
    const scored = combined
      .map((item) => {
        const nameLower = (item.name || "").toLowerCase();
        const categoryLower = (item.category || "").toLowerCase();
        const searchText = [
          item.description,
          item.new_description,
          ...(item.tags || []),
          ...(item.profession || []),
        ].join(" ").toLowerCase();

        let score = 0;

        words.forEach((word) => {
          // Exact full name match
          if (nameLower === word) score += 20;
          // Name starts with word (e.g. "mach" → "machine learning")
          else if (nameLower.startsWith(word)) score += 12;
          // Any word in name starts with typed word
          else if (nameLower.split(/\s+/).some(w => w.startsWith(word))) score += 9;
          // Name contains typed word anywhere
          else if (nameLower.includes(word)) score += 7;
          // Category match
          else if (categoryLower.includes(word)) score += 4;
          // Body text match
          else if (searchText.includes(word)) score += 2;
          // Algolia hit even without local text match (typo-corrected)
          else if (!item._fromMongo) score += 1;
        });

        return {
          ...item,
          rating: (Math.random() * (4.8 - 4.3) + 4.3).toFixed(1),
          _score: score,
        };
      })
      .filter((i) => i._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 20);

    res.json(scored);
  } catch (err) {
    console.error("🔴 Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});


function generateRandomRating() {
  return (Math.random() * (4.8 - 4.0) + 4.0).toFixed(1);
}

// API: Get a tool by ID
app.get("/api/tools/:id", async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid tool ID" });
  }
  try {
    const tool = await Tool.findById(id);
    if (!tool) return res.status(404).json({ error: "Tool not found" });
    res.json(tool);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// 📚 Ebook Schema
const ebookSchema = new mongoose.Schema(
  {
    name: String,
    image: String,
    author: String,
    publisher: String,
    publish_date: String,
    category: String,
  },
  { collection: "ebooks" }
);

const Ebook = mongoose.model("Ebook", ebookSchema);

const ebookCategorySchema = new mongoose.Schema(
  { name: { type: String, required: true } },
  { collection: "ebook_categories" }
);
const EbookCategory = mongoose.model("EbookCategory", ebookCategorySchema);

app.get("/api/ebook-categories", async (req, res) => {
  try {
    const categories = await Ebook.distinct("category");
    res.json(categories);
  } catch (err) {
    console.error("Error fetching ebook categories:", err);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

app.get("/api/ebooks", async (req, res) => {
  try {
    const ebooks = await Ebook.find();
    res.json(ebooks);
  } catch (err) {
    console.error("Error fetching ebooks:", err);
    res.status(500).json({ error: "Failed to fetch ebooks" });
  }
});

app.post("/api/ebooks/filter", async (req, res) => {
  const { categories } = req.body;
  try {
    let filter = {};
    if (categories && categories.length) {
      filter.category = { $in: categories };
    }
    const ebooks = await Ebook.find(filter);
    res.json(ebooks);
  } catch (err) {
    console.error("Error filtering ebooks:", err);
    res.status(500).json({ error: "Failed to filter ebooks" });
  }
});

app.get("/api/ebooks/:id", async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid Ebook ID" });
  }
  try {
    const ebook = await Ebook.findById(id);
    if (!ebook) return res.status(404).json({ error: "Ebook not found" });
    res.json(ebook);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Nodemailer
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

transporter.verify((err, success) => {
  if (err) {
    console.log("Error configuring email transporter:", err);
  } else {
    console.log("Email transporter is ready");
  }
});

app.post("/api/send-email", async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: "All fields are required." });
  }

  const mailOptions = {
    from: `"${name}" <${email}>`,
    to: process.env.recipient_email,
    subject: `New Contact Form Submission from ${name}`,
    text: `Name: ${name}\nEmail: ${email}\nMessage: ${message}`,
    html: `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Contact Form Submission</title>
      <style>
        body { margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f8; }
        .email-container { max-width: 600px; margin: 40px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(90deg, #4f46e5, #9333ea); padding: 30px; text-align: center; }
        .header img { width: 100px; height: 100px; border-radius: 50%; border: 4px solid #fff; object-fit: cover; }
        .banner { background: #e0f7fa; color: #00796b; font-weight: bold; text-align: center; padding: 12px 20px; border-radius: 8px; margin: 20px; }
        .content { padding: 20px 30px; }
        .content h2 { font-size: 22px; color: #333; margin-bottom: 10px; }
        .content p { font-size: 16px; color: #555; line-height: 1.6; margin-bottom: 10px; }
        .footer { background-color: #f1f1f5; padding: 20px; text-align: center; font-size: 14px; color: #888; border-top: 1px solid #ddd; }
        .footer a { color: #4f46e5; text-decoration: none; font-weight: 500; }
      </style>
    </head>
    <body>
      <div class="email-container">
        <div class="header">
          <img src="cid:logo" alt="Company Logo" />
        </div>
        <div class="banner">🚀 New Contact Form Submission Received!</div>
        <div class="content">
          <h2>Details</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Message:</strong><br>${message}</p>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} Select AI Tools. All rights reserved.<br>
          Visit us at <a href="https://selectaitools.com">selectaitools.com</a>
        </div>
      </div>
    </body>
    </html>
    `,
    attachments: [
      {
        filename: "logo.png",
        path: path.join(__dirname, "assets/logo.png"),
        cid: "logo"
      }
    ]
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ success: "Email sent successfully!" });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ error: "Failed to send email." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
