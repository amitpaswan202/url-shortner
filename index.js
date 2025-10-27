var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/index.ts
import express2 from "express";

// server/routes.ts
import { createServer } from "http";

// server/db.ts
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

// shared/schema.ts
var schema_exports = {};
__export(schema_exports, {
  clicks: () => clicks,
  insertClickSchema: () => insertClickSchema,
  insertLinkSchema: () => insertLinkSchema,
  links: () => links
});
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
var links = pgTable("links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shortCode: varchar("short_code", { length: 50 }).notNull().unique(),
  originalUrl: text("original_url").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
  clickCount: integer("click_count").notNull().default(0)
}, (table) => ({
  shortCodeIdx: index("short_code_idx").on(table.shortCode)
}));
var clicks = pgTable("clicks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  linkId: varchar("link_id").notNull().references(() => links.id, { onDelete: "cascade" }),
  clickedAt: timestamp("clicked_at").notNull().defaultNow(),
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  referrer: text("referrer"),
  country: varchar("country", { length: 2 }),
  city: text("city"),
  browser: varchar("browser", { length: 50 }),
  os: varchar("os", { length: 50 }),
  device: varchar("device", { length: 50 })
}, (table) => ({
  linkIdClickedAtIdx: index("link_id_clicked_at_idx").on(table.linkId, table.clickedAt)
}));
var insertLinkSchema = createInsertSchema(links).pick({
  originalUrl: true,
  shortCode: true
}).extend({
  originalUrl: z.string().url("Must be a valid URL"),
  shortCode: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/, "Only letters, numbers, hyphens, and underscores allowed").optional()
});
var insertClickSchema = createInsertSchema(clicks).omit({
  id: true,
  clickedAt: true
});

// server/db.ts
neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?"
  );
}
var pool = new Pool({ connectionString: process.env.DATABASE_URL });
var db = drizzle({ client: pool, schema: schema_exports });

// server/storage.ts
import { eq, desc, sql as sql2, and, gte } from "drizzle-orm";
var DbStorage = class {
  async createLink(linkData) {
    const [link] = await db.insert(links).values({
      originalUrl: linkData.originalUrl,
      shortCode: linkData.shortCode
    }).returning();
    return link;
  }
  async getLink(shortCode) {
    const [link] = await db.select().from(links).where(and(eq(links.shortCode, shortCode), eq(links.isActive, true))).limit(1);
    return link;
  }
  async getLinkById(id) {
    const [link] = await db.select().from(links).where(eq(links.id, id)).limit(1);
    return link;
  }
  async updateLinkClickCount(linkId) {
    await db.update(links).set({
      clickCount: sql2`${links.clickCount} + 1`
    }).where(eq(links.id, linkId));
  }
  async checkShortCodeExists(shortCode) {
    const [link] = await db.select({ id: links.id }).from(links).where(eq(links.shortCode, shortCode)).limit(1);
    return !!link;
  }
  async createClick(click) {
    const [newClick] = await db.insert(clicks).values(click).returning();
    return newClick;
  }
  async getLinkClicks(linkId) {
    return db.select().from(clicks).where(eq(clicks.linkId, linkId)).orderBy(desc(clicks.clickedAt));
  }
  async getLinkClicksInRange(linkId, startDate) {
    return db.select().from(clicks).where(and(
      eq(clicks.linkId, linkId),
      gte(clicks.clickedAt, startDate)
    )).orderBy(desc(clicks.clickedAt));
  }
  async getUniqueClickCount(linkId) {
    const result = await db.select({
      count: sql2`count(distinct ${clicks.ipAddress})`
    }).from(clicks).where(eq(clicks.linkId, linkId));
    return result[0]?.count || 0;
  }
};
var storage = new DbStorage();

// server/routes.ts
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import geoip from "geoip-lite";
import useragent from "useragent";
var DOMAIN = process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "http://localhost:5000";
async function registerRoutes(app2) {
  app2.post("/api/shorten", async (req, res) => {
    try {
      const { originalUrl, shortCode: customAlias } = insertLinkSchema.parse(req.body);
      let shortCode;
      if (customAlias) {
        const exists = await storage.checkShortCodeExists(customAlias);
        if (exists) {
          return res.status(400).json({
            error: "Custom alias already taken. Please choose another."
          });
        }
        shortCode = customAlias;
      } else {
        shortCode = nanoid(6);
        let attempts = 0;
        while (await storage.checkShortCodeExists(shortCode) && attempts < 5) {
          shortCode = nanoid(6);
          attempts++;
        }
      }
      const link = await storage.createLink({
        originalUrl,
        shortCode
      });
      return res.json({
        id: link.id,
        shortCode: link.shortCode,
        shortUrl: `${DOMAIN}/${link.shortCode}`,
        originalUrl: link.originalUrl,
        qrCodeUrl: `${DOMAIN}/api/qr/${link.shortCode}`,
        statsUrl: `${DOMAIN}/${link.shortCode}/stats`,
        createdAt: link.createdAt
      });
    } catch (error) {
      console.error("Error creating short link:", error);
      if (error.issues) {
        return res.status(400).json({ error: error.issues[0].message });
      }
      return res.status(500).json({ error: "Failed to create short link" });
    }
  });
  app2.get("/api/check-alias/:alias", async (req, res) => {
    try {
      const { alias } = req.params;
      if (!/^[a-zA-Z0-9_-]{3,50}$/.test(alias)) {
        return res.json({
          available: false,
          error: "Alias must be 3-50 characters and contain only letters, numbers, hyphens, and underscores"
        });
      }
      const exists = await storage.checkShortCodeExists(alias);
      return res.json({ available: !exists });
    } catch (error) {
      console.error("Error checking alias:", error);
      return res.status(500).json({ error: "Failed to check alias availability" });
    }
  });
  app2.get("/api/qr/:shortCode", async (req, res) => {
    try {
      const { shortCode } = req.params;
      const link = await storage.getLink(shortCode);
      if (!link) {
        return res.status(404).json({ error: "Link not found" });
      }
      const shortUrl = `${DOMAIN}/${shortCode}`;
      const qrCode = await QRCode.toDataURL(shortUrl, {
        width: 400,
        margin: 2,
        color: {
          dark: "#000000",
          light: "#FFFFFF"
        }
      });
      return res.json({ qrCode, shortUrl });
    } catch (error) {
      console.error("Error generating QR code:", error);
      return res.status(500).json({ error: "Failed to generate QR code" });
    }
  });
  app2.get("/api/links/:shortCode/stats", async (req, res) => {
    try {
      const { shortCode } = req.params;
      const { period = "7d" } = req.query;
      const link = await storage.getLink(shortCode);
      if (!link) {
        return res.status(404).json({ error: "Link not found" });
      }
      const now = /* @__PURE__ */ new Date();
      const daysAgo = period === "24h" ? 1 : period === "30d" ? 30 : 7;
      const startDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1e3);
      const allClicks = await storage.getLinkClicksInRange(link.id, startDate);
      const uniqueCount = await storage.getUniqueClickCount(link.id);
      const clicksByDate = {};
      const referrers = {};
      const countries = {};
      const browsers = {};
      const devices = {};
      const os = {};
      allClicks.forEach((click) => {
        const dateKey = click.clickedAt.toISOString().split("T")[0];
        clicksByDate[dateKey] = (clicksByDate[dateKey] || 0) + 1;
        const ref = click.referrer || "Direct";
        referrers[ref] = (referrers[ref] || 0) + 1;
        if (click.country) {
          countries[click.country] = (countries[click.country] || 0) + 1;
        }
        if (click.browser) {
          browsers[click.browser] = (browsers[click.browser] || 0) + 1;
        }
        if (click.device) {
          devices[click.device] = (devices[click.device] || 0) + 1;
        }
        if (click.os) {
          os[click.os] = (os[click.os] || 0) + 1;
        }
      });
      return res.json({
        link: {
          shortCode: link.shortCode,
          originalUrl: link.originalUrl,
          shortUrl: `${DOMAIN}/${link.shortCode}`,
          createdAt: link.createdAt
        },
        stats: {
          totalClicks: link.clickCount,
          uniqueClicks: uniqueCount,
          clicksByDate,
          referrers,
          countries,
          browsers,
          devices,
          os
        }
      });
    } catch (error) {
      console.error("Error fetching stats:", error);
      return res.status(500).json({ error: "Failed to fetch statistics" });
    }
  });
  app2.get("/:shortCode", async (req, res) => {
    try {
      const { shortCode } = req.params;
      if (shortCode === "api" || shortCode === "assets" || shortCode === "src") {
        return res.status(404).send("Not found");
      }
      const link = await storage.getLink(shortCode);
      if (!link) {
        return res.status(404).send("Link not found");
      }
      const ipAddress = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "";
      const userAgentString = req.headers["user-agent"] || "";
      const referrer = req.headers["referer"] || req.headers["referrer"] || "";
      const agent = useragent.parse(userAgentString);
      const geo = geoip.lookup(ipAddress);
      storage.createClick({
        linkId: link.id,
        ipAddress,
        userAgent: userAgentString,
        referrer,
        country: geo?.country || null,
        city: geo?.city || null,
        browser: agent.family,
        os: agent.os.family,
        device: agent.device.family === "Other" ? "Desktop" : agent.device.family
      }).catch((err) => console.error("Error tracking click:", err));
      storage.updateLinkClickCount(link.id).catch((err) => console.error("Error updating click count:", err));
      return res.redirect(301, link.originalUrl);
    } catch (error) {
      console.error("Error handling redirect:", error);
      return res.status(500).send("Internal server error");
    }
  });
  const httpServer = createServer(app2);
  return httpServer;
}

// server/vite.ts
import express from "express";
import fs from "fs";
import path2 from "path";
import { createServer as createViteServer, createLogger } from "vite";

// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
var vite_config_default = defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    ...process.env.NODE_ENV !== "production" && process.env.REPL_ID !== void 0 ? [
      await import("@replit/vite-plugin-cartographer").then(
        (m) => m.cartographer()
      ),
      await import("@replit/vite-plugin-dev-banner").then(
        (m) => m.devBanner()
      )
    ] : []
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets")
    }
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/vite.ts
import { nanoid as nanoid2 } from "nanoid";
var viteLogger = createLogger();
function log(message, source = "express") {
  const formattedTime = (/* @__PURE__ */ new Date()).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}
async function setupVite(app2, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      }
    },
    server: serverOptions,
    appType: "custom"
  });
  app2.use(vite.middlewares);
  app2.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html"
      );
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid2()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app2) {
  const distPath = path2.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app2.use(express.static(distPath));
  app2.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/index.ts
var app = express2();
app.use(express2.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express2.urlencoded({ extended: false }));
app.use((req, res, next) => {
  const start = Date.now();
  const path3 = req.path;
  let capturedJsonResponse = void 0;
  const originalResJson = res.json;
  res.json = function(bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path3.startsWith("/api")) {
      let logLine = `${req.method} ${path3} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      log(logLine);
    }
  });
  next();
});
(async () => {
  const server = await registerRoutes(app);
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    throw err;
  });
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true
  }, () => {
    log(`serving on port ${port}`);
  });
})();
