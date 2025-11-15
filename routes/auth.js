const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { body, validationResult } = require("express-validator");

const router = express.Router();
const prisma = new PrismaClient();

router.post(
  "/signup",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 6 }),
    body("name").optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, name } = req.body;

    try {
      const existingUser = await prisma.user.findUnique({ where: { email } });

      if (existingUser) {
        return res.status(400).json({
          success: false,
          error: "Email already registered",
        });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name: name || null,
          plan: "FREE",
          creditsRemaining: 3,
        },
      });

      const token = jwt.sign(
        { userId: user.id, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      return res.json({
        success: true,
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            plan: user.plan,
            creditsRemaining: user.creditsRemaining,
          },
        },
      });
    } catch (error) {
      console.error("Signup error:", error);
      return res.status(500).json({
        success: false,
        error: "Signup failed",
      });
    }
  }
);

router.post(
  "/login",
  [body("email").isEmail().normalizeEmail(), body("password").exists()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      const user = await prisma.user.findUnique({ where: { email } });

      if (!user) {
        return res.status(401).json({
          success: false,
          error: "Invalid credentials",
        });
      }

      const validPassword = await bcrypt.compare(password, user.password);

      if (!validPassword) {
        return res.status(401).json({
          success: false,
          error: "Invalid credentials",
        });
      }

      const token = jwt.sign(
        { userId: user.id, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      return res.json({
        success: true,
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            plan: user.plan,
            creditsRemaining: user.creditsRemaining,
          },
        },
      });
    } catch (error) {
      console.error("Login error:", error);
      return res.status(500).json({
        success: false,
        error: "Login failed",
      });
    }
  }
);

module.exports = router;
