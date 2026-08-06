import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  index("auth_sessions_user_id_idx").on(table.userId),
  index("auth_sessions_expires_at_idx").on(table.expiresAt),
]);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workspaceState = sqliteTable("workspace_state", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  stateJson: text("state_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const subscriptions = sqliteTable("subscriptions", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  planCode: text("plan_code", { enum: ["free", "creator", "studio"] }).notNull(),
  status: text("status", { enum: ["trialing", "active", "past_due", "canceled"] }).notNull(),
  includedRenders: integer("included_renders").notNull().default(0),
  rendersUsed: integer("renders_used").notNull().default(0),
  currentPeriodStart: text("current_period_start").notNull(),
  currentPeriodEnd: text("current_period_end"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
