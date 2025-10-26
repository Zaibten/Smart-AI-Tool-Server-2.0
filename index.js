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
  'http://localhost:4028'
];

app.use(cors({
  origin: function(origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
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
console.log(
  "✅ Algolia API Key:",
  process.env.ALGOLIA_ADMIN_API_KEY ? "Loaded" : "Missing"
);
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
    rating: Number, // stored in DB but not used directly
    pricing: String,
    official_link: String,
    availability: String,
    details: String,
    profession: [String],   // professions
    tags: [String],         // tags
    new_description: String,
    image_url: String,      // image URL from DB
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
      profession: tool.profession ? tool.profession.slice(0, 2) : [], // limit professions
      tags: tool.tags ? tool.tags.slice(0, 5) : [],                   // limit tags
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
    
    // Flatten professions
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

// API: Get tools by category & profession filters (supports multiple selection)
app.post("/api/tools/filter", async (req, res) => {
  const { categories, professions, featured, pricing } = req.body;

  let filter = {};

  if (categories && categories.length) filter.category = { $in: categories };
  if (professions && professions.length) filter.profession = { $in: professions };
  if (featured) filter.featured = true;           // Featured tools
  if (pricing) filter.pricing = pricing;          // "Free" or "Paid"

  try {
    const tools = await Tool.find(filter);
    res.json(tools);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch tools" });
  }
});



// API: Get total number of tools
app.get("/api/tools/count", async (req, res) => {
  try {
    const totalTools = await Tool.countDocuments();
    res.json({ total: totalTools });
  } catch (error) {
    console.error("Error counting tools:", error);
    res.status(500).json({ error: "Failed to count tools" });
  }
});

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
    res.json({ success: true, message: "✅ Tools synced to Algolia successfully!" });
  } catch (err) {
    console.error("Algolia sync error:", err);
    res.status(500).json({ error: "Failed to sync data with Algolia" });
  }
});

app.get("/api/searchtools", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  try {
    // === Step 1: Extract meaningful intent keywords ===
    const hfResponse = await fetch(
      "https://api-inference.huggingface.co/models/facebook/bart-large-mnli",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: `Extract the main AI tool intent keywords from: "${q}"`,
        }),
      }
    );

    const hfData = await hfResponse.json();
    const extracted =
      hfData[0]?.generated_text ||
      hfData[0]?.summary_text ||
      q.toLowerCase().trim();
    console.log("🎯 Refined query:", extracted);

    // === Step 2: Search Algolia for those refined keywords ===
    const algoliaResult = await index.search(extracted, {
      typoTolerance: "min",
      hitsPerPage: 40,
      ignorePlurals: true,
      removeWordsIfNoResults: "allOptional",
      filters: 'NOT category:"unrelated"',
    });

    let hits = algoliaResult.hits;

    // === Step 3: (Optional) Secondary relevance filter using MongoDB ===
    const regex = new RegExp(extracted.split(" ").join("|"), "i");
    const mongoResults = await Tool.find({
      $or: [
        { name: regex },
        { description: regex },
        { new_description: regex },
        { category: regex },
        { tags: regex },
        { profession: regex },
      ],
    });

    // Merge Algolia + Mongo results (unique by _id / objectID)
    const mongoIds = new Set(mongoResults.map((t) => String(t._id)));
    const combined = [
      ...hits.filter((h) => !mongoIds.has(String(h.objectID))),
      ...mongoResults.map((t) => ({
        objectID: t._id,
        name: t.name,
        description: t.description,
        category: t.category,
        pricing: t.pricing,
        link: t.link,
        image_url: t.image_url,
        rating: (Math.random() * (4.8 - 4.3) + 4.3).toFixed(1),
      })),
    ];

    // === Step 4: Score by semantic closeness (simple string similarity) ===
    const normalizedQ = extracted.toLowerCase();
    const scored = combined
      .map((item) => {
        const text =
          `${item.name} ${item.description} ${item.category}`.toLowerCase();
        let score = 0;
        normalizedQ.split(" ").forEach((word) => {
          if (text.includes(word)) score += 1;
        });
        return { ...item, _score: score };
      })
      .sort((a, b) => b._score - a._score)
      .filter((i) => i._score > 0); // remove unrelated ones

    // === Step 5: Return refined list ===
    res.json(scored.slice(0, 20)); // return top 20 most relevant tools
  } catch (err) {
    console.error("🔴 Advanced search error:", err);
    res.status(500).json({ error: "Semantic search failed" });
  }
});


// GET /api/tools/search?q=searchText
// app.get("/api/tools/search", async (req, res) => {
//   const { q } = req.query;
//   if (!q) return res.json([]);

//   try {
//     const regex = new RegExp(q, "i"); // case-insensitive search
//     const tools = await Tool.find({
//       $or: [
//         { name: regex },
//         { description: regex },
//         { new_description: regex },
//         { tags: regex },
//       ],
//     });
//     res.json(tools);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Search failed" });
//   }
// });


// Generate random rating between 4.0 and 4.8
function generateRandomRating() {
  return (Math.random() * (4.8 - 4.0) + 4.0).toFixed(1);
}

// API: Get a tool by ID
app.get("/api/tools/:id", async (req, res) => {
  const { id } = req.params;

  // Check if id is a valid ObjectId
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

// 📂 Ebook Category Schema
const ebookCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
  },
  { collection: "ebook_categories" } // make sure this matches your DB collection
);

const EbookCategory = mongoose.model("EbookCategory", ebookCategorySchema);

// ✅ Route: Get ebook categories directly from ebooks
app.get("/api/ebook-categories", async (req, res) => {
  try {
    const categories = await Ebook.distinct("category");
    res.json(categories);
  } catch (err) {
    console.error("Error fetching ebook categories:", err);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});



// API: Get all ebooks
app.get("/api/ebooks", async (req, res) => {
  try {
    const ebooks = await Ebook.find();
    res.json(ebooks);
  } catch (err) {
    console.error("Error fetching ebooks:", err);
    res.status(500).json({ error: "Failed to fetch ebooks" });
  }
});


// ✅ API: Filter ebooks by category (supports multiple categories)
app.post("/api/ebooks/filter", async (req, res) => {
  const { categories } = req.body;

  try {
    let filter = {};

    // if categories provided → filter only those
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

// GET /api/ebooks/:id
app.get("/api/ebooks/:id", async (req, res) => {
  const { id } = req.params;

  // Validate Mongo ObjectId
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

// Nodemailer transporter using env variables
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// Verify transporter
transporter.verify((err, success) => {
  if (err) {
    console.log("Error configuring email transporter:", err);
  } else {
    console.log("Email transporter is ready");
  }
});

// API to receive email from modal
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
      body {
        margin: 0;
        padding: 0;
        font-family: 'Helvetica Neue', Arial, sans-serif;
        background-color: #f4f4f8;
      }
      .email-container {
        max-width: 600px;
        margin: 40px auto;
        background: #fff;
        border-radius: 16px;
        overflow: hidden;
        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        animation: fadeIn 1.2s ease-in-out;
      }

      /* Fade-in animation */
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-30px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* Header with gradient background */
      .header {
        background: linear-gradient(90deg, #4f46e5, #9333ea);
        padding: 30px;
        text-align: center;
      }
      .header img {
        width: 100px;
        height: 100px;
        border-radius: 50%;
        border: 4px solid #fff;
        object-fit: cover;
        animation: logoPulse 2s infinite alternate;
      }

      /* Logo pulse animation */
      @keyframes logoPulse {
        from { transform: scale(1); }
        to { transform: scale(1.08); }
      }

      .banner {
        background: #e0f7fa;
        color: #00796b;
        font-weight: bold;
        text-align: center;
        padding: 12px 20px;
        border-radius: 8px;
        margin: 20px;
        animation: slideIn 1s ease-out;
      }

      /* Slide-in animation */
      @keyframes slideIn {
        from { transform: translateX(-100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }

      .content {
        padding: 20px 30px;
      }
      .content h2 {
        font-size: 22px;
        color: #333;
        margin-bottom: 10px;
      }
      .content p {
        font-size: 16px;
        color: #555;
        line-height: 1.6;
        margin-bottom: 10px;
      }

      /* Footer styling */
      .footer {
        background-color: #f1f1f5;
        padding: 20px;
        text-align: center;
        font-size: 14px;
        color: #888;
        border-top: 1px solid #ddd;
      }
      .footer a {
        color: #4f46e5;
        text-decoration: none;
        font-weight: 500;
      }

      /* Responsive adjustments */
      @media (max-width: 640px) {
        .content, .banner { padding: 15px; }
        .header img { width: 80px; height: 80px; }
      }
    </style>
  </head>
  <body>
    <div class="email-container">
      <!-- Header with Logo -->
      <div class="header">
        <img src="cid:logo" alt="Company Logo" />
      </div>

      <!-- Animated Banner -->
      <div class="banner">
        🚀 New Contact Form Submission Received!
      </div>

      <!-- Content -->
      <div class="content">
        <h2>Details</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Message:</strong><br>${message}</p>
      </div>

      <!-- Footer -->
      <div class="footer">
        &copy; ${new Date().getFullYear()} Select AI Tools. All rights reserved.<br>
        Visit us at <a href="https://selectaitools.com">yourwebsite.com</a>
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



// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
