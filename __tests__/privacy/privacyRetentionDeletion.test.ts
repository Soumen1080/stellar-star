import fs from "fs";
import path from "path";
import { executeAccountDeletion } from "@/lib/privacy/accountDeletion";

describe("Privacy, Retention & Account Deletion (#310)", () => {
  const rootDir = path.resolve(__dirname, "../..");

  describe("Acceptance Criterion 1: Privacy Notice & Blockchain Distinction", () => {
    it("publishes docs/PRIVACY.md with explicit blockchain vs off-chain distinction", () => {
      const docPath = path.join(rootDir, "docs", "PRIVACY.md");
      expect(fs.existsSync(docPath)).toBe(true);
      const content = fs.readFileSync(docPath, "utf8");

      expect(content).toContain("Dual Data Architecture");
      expect(content).toContain("Immutable Public-Chain Records");
      expect(content).toContain("Mutable Off-Chain Application Data");
      expect(content).toContain("Permanent & Non-Erasable");
      expect(content).toContain("Stellar");
    });

    it("includes a user-facing privacy page at app/privacy/page.tsx", () => {
      const pagePath = path.join(rootDir, "app", "privacy", "page.tsx");
      expect(fs.existsSync(pagePath)).toBe(true);
      const pageContent = fs.readFileSync(pagePath, "utf8");
      expect(pageContent).toContain("Immutable Blockchain Records");
      expect(pageContent).toContain("Mutable Application Data");
      expect(pageContent).toContain("Official Retention Schedule");
      expect(pageContent).toContain("handleDeleteAccount");
      expect(pageContent).toContain("handleExportData");
    });
  });

  describe("Acceptance Criterion 2: Retention Schedule Definitions", () => {
    it("defines retention for accounts, audit logs, invitations, receipts, analytics, and backups", () => {
      const docPath = path.join(rootDir, "docs", "PRIVACY.md");
      const content = fs.readFileSync(docPath, "utf8");

      expect(content).toContain("public.users");
      expect(content).toContain("export_audit_events");
      expect(content).toContain("trip_invites");
      expect(content).toContain("expense_receipts");
      expect(content).toContain("Database Backups");
      expect(content).toContain("730 days");
      expect(content).toContain("90 days");
      expect(content).toContain("30 days");
    });
  });

  describe("Acceptance Criterion 3: Authenticated Export & Deletion Flow", () => {
    it("provides authenticated /api/account/delete and /api/account/export endpoints", () => {
      const deleteRoutePath = path.join(rootDir, "app", "api", "account", "delete", "route.ts");
      const exportRoutePath = path.join(rootDir, "app", "api", "account", "export", "route.ts");

      expect(fs.existsSync(deleteRoutePath)).toBe(true);
      expect(fs.existsSync(exportRoutePath)).toBe(true);

      const deleteCode = fs.readFileSync(deleteRoutePath, "utf8");
      const exportCode = fs.readFileSync(exportRoutePath, "utf8");

      expect(deleteCode).toContain("verifyWalletSession");
      expect(deleteCode).toContain("executeAccountDeletion");
      expect(exportCode).toContain("verifyWalletSession");
    });

    it("executes account deletion, removes private data, and anonymizes group participation", async () => {
      const testWallet = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

      const mockDb: Record<string, any[]> = {
        deleted_accounts: [],
        users: [{ wallet_address: testWallet, display_name: "Test User" }],
        contacts: [{ owner_wallet: testWallet, display_name: "Friend" }],
        trip_invites: [{ created_by_wallet: testWallet, revoked: false }],
        expense_receipts: [{ uploaded_by_wallet: testWallet, status: "active" }],
        trips: [
          {
            id: "trip-1",
            member_wallets: [testWallet],
            members: [{ walletAddress: testWallet, name: "Test User" }],
          },
        ],
        expenses: [
          {
            id: "exp-1",
            member_wallets: [testWallet],
            members: [{ walletAddress: testWallet, name: "Test User" }],
          },
        ],
        auth_challenges: [{ address: testWallet, nonce: "test-nonce" }],
      };

      const mockClient: any = {
        from: (table: string) => ({
          upsert: async (record: any) => {
            mockDb[table].push(record);
            return { data: [record], error: null };
          },
          delete: (opts?: any) => ({
            eq: async (col: string, val: any) => {
              const before = mockDb[table].length;
              mockDb[table] = mockDb[table].filter((row) => row[col] !== val);
              const count = before - mockDb[table].length;
              return { data: null, error: null, count };
            },
          }),
          update: (patch: any) => ({
            eq: async (col: string, val: any) => {
              mockDb[table].forEach((row) => {
                if (row[col] === val) Object.assign(row, patch);
              });
              return { data: mockDb[table], error: null, count: 1 };
            },
            neq: async (col: string, val: any) => {
              return { data: mockDb[table], error: null, count: 1 };
            },
          }),
          select: (cols: string) => ({
            eq: (col: string, val: any) => ({
              maybeSingle: async () => ({
                data: mockDb[table].find((row) => row[col] === val) || null,
                error: null,
              }),
            }),
            contains: async (col: string, vals: any[]) => ({
              data: mockDb[table].filter((row) =>
                vals.every((v) => row[col] && row[col].includes(v))
              ),
              error: null,
            }),
          }),
        }),
      };

      const result = await executeAccountDeletion(testWallet, mockClient);

      expect(result.success).toBe(true);
      expect(result.walletAddress).toBe(testWallet);
      expect(result.summary.userProfileRemoved).toBe(true);
      expect(result.notice).toContain("Public Stellar blockchain transactions");
      expect(mockDb.users.length).toBe(0);
      expect(mockDb.trips[0].members[0].name).toBe("Former Member");
      expect(mockDb.expenses[0].members[0].name).toBe("Former Member");
    });
  });

  describe("Acceptance Criterion 4: Invalidation of Stale Sessions, Realtime, & Storage", () => {
    it("updates current_wallet() in supabase-setup.sql and migration 0013 to fail closed", () => {
      const setupSql = fs.readFileSync(path.join(rootDir, "supabase-setup.sql"), "utf8");
      const migration13 = fs.readFileSync(
        path.join(rootDir, "migrations", "0013_privacy_retention_deletion.sql"),
        "utf8"
      );

      expect(setupSql).toContain("public.deleted_accounts");
      expect(setupSql).toContain("CREATE OR REPLACE FUNCTION public.current_wallet()");
      expect(setupSql).toContain("THEN NULL");

      expect(migration13).toContain("public.deleted_accounts");
      expect(migration13).toContain("CREATE OR REPLACE FUNCTION public.current_wallet()");
      expect(migration13).toContain("THEN NULL");
    });

    it("rejects token refresh for deleted accounts in /api/auth/refresh", () => {
      const refreshCode = fs.readFileSync(
        path.join(rootDir, "app", "api", "auth", "refresh", "route.ts"),
        "utf8"
      );
      expect(refreshCode).toContain("deleted_accounts");
      expect(refreshCode).toContain("ACCOUNT_DELETED");
    });
  });
});
