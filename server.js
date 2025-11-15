const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { OpenAI } = require("openai");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const authRoutes = require("./routes/auth");
const authMiddleware = require("./middleware/auth");

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? process.env.FRONTEND_URL
        : "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  const validTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  validTypes.includes(file.mimetype)
    ? cb(null, true)
    : cb(new Error("Invalid file type"));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5242880 },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const parseDocument = async (file) => {
  if (file.mimetype === "application/pdf") {
    const result = await pdfParse(file.buffer);
    return result.text;
  }

  const { value } = await mammoth.extractRawText({ buffer: file.buffer });
  return value;
};

const getAtsAnalysis = async (resume, description) => {
  const systemPrompt =
    "You are an ATS expert. Return only valid JSON with score, missingKeywords array, and suggestions array.";

  const userPrompt = `Analyze this resume against the job description.

Resume: ${resume}

Job: ${description}

Provide ATS score (0-100), top 5 missing keywords, and 3-4 improvement tips.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 600,
  });

  const raw = completion.choices[0].message.content;
  const cleaned = raw.replace(/```(?:json)?\n?|\n?```/g, "").trim();
  return JSON.parse(cleaned);
};

app.use("/api/auth", authRoutes);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: Date.now(),
    uptime: Math.floor(process.uptime()),
  });
});

app.post(
  "/api/analyze",
  authMiddleware,
  upload.single("resume"),
  async (req, res) => {
    const { jobDescription } = req.body;
    const file = req.file;
    const user = req.user;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: "Resume file required",
      });
    }

    if (!jobDescription?.trim()) {
      return res.status(400).json({
        success: false,
        error: "Job description required",
      });
    }

    if (jobDescription.trim().length < 50) {
      return res.status(400).json({
        success: false,
        error: "Job description too short (min 50 characters)",
      });
    }

    if (user.plan === "FREE" && user.creditsRemaining <= 0) {
      return res.status(403).json({
        success: false,
        error: "No credits remaining. Please upgrade to Pro.",
      });
    }

    try {
      const resumeText = await parseDocument(file);

      if (!resumeText?.trim()) {
        return res.status(400).json({
          success: false,
          error: "Could not extract text from file",
        });
      }

      const analysis = await getAtsAnalysis(resumeText, jobDescription);

      const savedAnalysis = await prisma.analysis.create({
        data: {
          userId: user.id,
          resumeText,
          jobDescription,
          score: analysis.score,
          missingKeywords: analysis.missingKeywords,
          suggestions: analysis.suggestions,
        },
      });

      if (user.plan === "FREE") {
        await prisma.user.update({
          where: { id: user.id },
          data: { creditsRemaining: user.creditsRemaining - 1 },
        });
      }

      return res.json({
        success: true,
        data: {
          id: savedAnalysis.id,
          score: analysis.score,
          missingKeywords: analysis.missingKeywords,
          suggestions: analysis.suggestions,
          creditsRemaining:
            user.plan === "FREE" ? user.creditsRemaining - 1 : 999,
        },
      });
    } catch (err) {
      console.error("Analysis failed:", err);
      return res.status(500).json({
        success: false,
        error: "Analysis failed",
        message: err.message,
      });
    }
  }
);

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

const server = app.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});
