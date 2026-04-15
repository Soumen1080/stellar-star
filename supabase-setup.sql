-- ============================================================================
-- SettleX - Supabase Database Setup
-- ============================================================================
-- ✅ SAFE TO RUN MULTIPLE TIMES - This script is fully idempotent
-- It will create new objects or update existing ones without errors
--
-- Instructions:
-- 1. Go to: Supabase Dashboard → SQL Editor → New Query
-- 2. Copy & paste this entire file
-- 3. Click "Run" or press Ctrl+Enter
-- ============================================================================

-- ============================================================================
-- 1. CREATE TABLES
-- ============================================================================

-- Create users table (for wallet-based authentication)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    wallet_address TEXT UNIQUE NOT NULL, -- Stellar wallet address (primary identifier)
    display_name TEXT NOT NULL, -- User's display name (required)
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_login_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Create expenses table
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    title TEXT NOT NULL,
    description TEXT,
    total_amount TEXT NOT NULL,
    currency TEXT DEFAULT 'XLM' NOT NULL,
    split_mode TEXT NOT NULL CHECK (
        split_mode IN ('equal', 'custom')
    ),
    paid_by_member_id TEXT NOT NULL,
    members JSONB NOT NULL DEFAULT '[]',
    shares JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    settled BOOLEAN DEFAULT FALSE NOT NULL,
    -- New: Track creator and member wallets for authentication
    created_by_wallet TEXT NOT NULL,  -- Stellar address of expense creator
    member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]  -- Array of all member wallet addresses
);

-- Create trips table
CREATE TABLE IF NOT EXISTS trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  members JSONB NOT NULL DEFAULT '[]',
  expense_ids TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  settled BOOLEAN DEFAULT FALSE NOT NULL,
  -- New: Track creator and member wallets for authentication
  created_by_wallet TEXT NOT NULL,  -- Stellar address of trip creator
  member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]  -- Array of all member wallet addresses
);

-- ============================================================================
-- 1.5. ADD WALLET COLUMNS (if tables already exist from previous setup)
-- ============================================================================
-- These statements safely add the wallet columns if they're missing
-- This allows upgrading existing databases without dropping tables

-- Add wallet columns to expenses table if they don't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'expenses' AND column_name = 'created_by_wallet'
    ) THEN
        ALTER TABLE expenses ADD COLUMN created_by_wallet TEXT NOT NULL DEFAULT '';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'expenses' AND column_name = 'member_wallets'
    ) THEN
        ALTER TABLE expenses ADD COLUMN member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
    END IF;
END $$;

-- Add wallet columns to trips table if they don't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'trips' AND column_name = 'created_by_wallet'
    ) THEN
        ALTER TABLE trips ADD COLUMN created_by_wallet TEXT NOT NULL DEFAULT '';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'trips' AND column_name = 'member_wallets'
    ) THEN
        ALTER TABLE trips ADD COLUMN member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
    END IF;
END $$;

-- Update users table schema (make display_name required, remove email if exists)
DO $$ 
BEGIN
    -- Set default value for any existing NULL display_name values (only if rows exist)
    IF EXISTS (SELECT 1 FROM users LIMIT 1) THEN
        UPDATE users SET display_name = 'User' WHERE display_name IS NULL OR display_name = '';
    END IF;
    
    -- Make display_name NOT NULL if it's currently nullable
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'display_name' AND is_nullable = 'YES'
    ) THEN
        ALTER TABLE users ALTER COLUMN display_name SET NOT NULL;
    END IF;

    -- Drop email column only if it actually exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
    ) THEN
        ALTER TABLE users DROP COLUMN email;
    END IF;
END $$;

-- ============================================================================
-- 2. CREATE INDEXES (for better query performance)
-- ============================================================================

-- Indexes for users
CREATE INDEX IF NOT EXISTS idx_users_wallet_address ON users (wallet_address);

CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);

-- Indexes for expenses

CREATE INDEX IF NOT EXISTS idx_expenses_created_by_wallet ON expenses (created_by_wallet);

CREATE INDEX IF NOT EXISTS idx_expenses_member_wallets ON expenses USING GIN (member_wallets);

CREATE INDEX IF NOT EXISTS idx_expenses_created_at ON expenses (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_settled ON expenses (settled);

CREATE INDEX IF NOT EXISTS idx_trips_created_by_wallet ON trips (created_by_wallet);

CREATE INDEX IF NOT EXISTS idx_trips_member_wallets ON trips USING GIN (member_wallets);
-- Indexes for trips
CREATE INDEX IF NOT EXISTS idx_trips_created_at ON trips (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trips_settled ON trips (settled);

-- ============================================================================
-- 3. ENABLE ROW LEVEL SECURITY & CREATE ACCESS POLICIES
-- ============================================================================
-- This section enables RLS and creates wallet-based authentication policies
-- Members can only see/edit expenses/trips they're part of
-- Uses custom header 'x-wallet-address' passed from the app
-- ============================================================================

-- Enable RLS on all tables (required before creating policies)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

ALTER TABLE trips ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Anyone can view users" ON users;

DROP POLICY IF EXISTS "Users can insert their own profile" ON users;

DROP POLICY IF EXISTS "Users can update their own profile" ON users;

DROP POLICY IF EXISTS "Allow all operations on expenses" ON expenses;

DROP POLICY IF EXISTS "Allow all operations on trips" ON trips;

DROP POLICY IF EXISTS "Members can view their expenses" ON expenses;

DROP POLICY IF EXISTS "Members can create expenses" ON expenses;

DROP POLICY IF EXISTS "Members can update their expenses" ON expenses;

DROP POLICY IF EXISTS "Creator can delete expense" ON expenses;

DROP POLICY IF EXISTS "Members can view their trips" ON trips;

DROP POLICY IF EXISTS "Members can create trips" ON trips;

DROP POLICY IF EXISTS "Members can update their trips" ON trips;

DROP POLICY IF EXISTS "Creator can delete trip" ON trips;

-- ============================================================================
-- OPTION A: Simple Public Access (Development/Testing Only)
-- ============================================================================
-- Uncomment these lines for development/testing - anyone can access all data
-- Comment out again when you implement wallet authentication
-- NOT RECOMMENDED for production!

-- CREATE POLICY "Allow all operations on users" ON users FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "Allow all operations on expenses" ON expenses FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "Allow all operations on trips" ON trips FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- OPTION B: Wallet-Based Access Control (Production - CURRENTLY ACTIVE ✓)
-- ============================================================================
-- Only members can see/edit expenses/trips they're part of
-- This is the SECURE OPTION - keeps your data protected
-- Each user can only access expenses/trips where their wallet address is in member_wallets[]
-- ============================================================================

-- USERS POLICIES --

-- Anyone can view user profiles (for member selection in forms)
CREATE POLICY "Anyone can view users" ON users FOR
SELECT USING (true);

-- Users can insert their own profile during signup (wallet must match)
CREATE POLICY "Users can insert their own profile" ON users
FOR INSERT
WITH CHECK (
    wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address'
);

-- Users can only update their own profile
CREATE POLICY "Users can update their own profile" ON users
FOR UPDATE
USING (
    wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address'
)
WITH CHECK (
    wallet_address = current_setting('request.headers', true)::json->>'x-wallet-address'
);

-- EXPENSES POLICIES --

-- Members can view expenses they're part of
-- Also allows any wallet that appears on a share (covers trip members who
-- were added without a wallet address at trip creation time)
CREATE POLICY "Members can view their expenses" ON expenses
FOR SELECT
USING (
    current_setting('request.headers', true)::json->>'x-wallet-address' = ANY(member_wallets)
    OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(shares) AS s
        WHERE s->>'walletAddress' = current_setting('request.headers', true)::json->>'x-wallet-address'
    )
);

-- Any connected wallet can create an expense (they become the creator)
CREATE POLICY "Members can create expenses" ON expenses
FOR INSERT
WITH CHECK (
    -- Creator wallet matches the connected wallet
    created_by_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
    AND
    -- Creator must be in the members list
    created_by_wallet = ANY(member_wallets)
);

-- Members can update expenses they're part of
-- Also allows any wallet that appears on a share (even if not in member_wallets)
-- so members can record their own payment regardless of how the expense was created
CREATE POLICY "Members can update their expenses" ON expenses
FOR UPDATE
USING (
    current_setting('request.headers', true)::json->>'x-wallet-address' = ANY(member_wallets)
    OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(shares) AS s
        WHERE s->>'walletAddress' = current_setting('request.headers', true)::json->>'x-wallet-address'
    )
)
WITH CHECK (
    current_setting('request.headers', true)::json->>'x-wallet-address' = ANY(member_wallets)
    OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(shares) AS s
        WHERE s->>'walletAddress' = current_setting('request.headers', true)::json->>'x-wallet-address'
    )
);

-- Only the creator can delete an expense
CREATE POLICY "Creator can delete expense" ON expenses
FOR DELETE
USING (
    created_by_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
);

-- TRIPS POLICIES --

-- Members can view trips they're part of
CREATE POLICY "Members can view their trips" ON trips
FOR SELECT
USING (
    current_setting('request.headers', true)::json->>'x-wallet-address' = ANY(member_wallets)
);

-- Any connected wallet can create a trip
CREATE POLICY "Members can create trips" ON trips
FOR INSERT
WITH CHECK (
    created_by_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
    AND
    created_by_wallet = ANY(member_wallets)
);

-- Members can update trips they're part of
CREATE POLICY "Members can update their trips" ON trips
FOR UPDATE
USING (
    current_setting('request.headers', true)::json->>'x-wallet-address' = ANY(member_wallets)
)
WITH CHECK (
    current_setting('request.headers', true)::json->>'x-wallet-address' = ANY(member_wallets)
);

-- Only the creator can delete a trip
CREATE POLICY "Creator can delete trip" ON trips
FOR DELETE
USING (
    created_by_wallet = current_setting('request.headers', true)::json->>'x-wallet-address'
);

-- ============================================================================
-- 4. ENABLE REALTIME (for live updates across browsers)
-- ============================================================================
-- Safely add tables to realtime publication (only if not already added)

DO $$
BEGIN
    -- Add users table to realtime if not already added
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' 
        AND schemaname = 'public' 
        AND tablename = 'users'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE users;

END IF;

-- Add expenses table to realtime if not already added
IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE
        pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'expenses'
) THEN
ALTER PUBLICATION supabase_realtime
ADD
TABLE expenses;

END IF;

-- Add trips table to realtime if not already added
IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE
        pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'trips'
) THEN
ALTER PUBLICATION supabase_realtime
ADD
TABLE trips;

END IF;

END $$;

-- ============================================================================
-- 5. CREATE UPDATED_AT TRIGGERS (Auto-update timestamps)
-- ============================================================================

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS update_users_updated_at ON users;

DROP TRIGGER IF EXISTS update_expenses_updated_at ON expenses;

DROP TRIGGER IF EXISTS update_trips_updated_at ON trips;

-- Create trigger for users
CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Create trigger for expenses
CREATE TRIGGER update_expenses_updated_at
BEFORE UPDATE ON expenses
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Create trigger for trips
CREATE TRIGGER update_trips_updated_at
BEFORE UPDATE ON trips
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 6. VERIFICATION QUERIES (Optional - Run to verify setup)
-- ============================================================================

-- Check tables exist
SELECT table_name
FROM information_schema.tables
WHERE
    table_schema = 'public'
    AND table_name IN ('users', 'expenses', 'trips');

-- Check indexes exist
SELECT indexname
FROM pg_indexes
WHERE
    tablename IN ('users', 'expenses', 'trips');

-- Check RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE
    tablename IN ('users', 'expenses', 'trips');

-- Check policies exist
SELECT tablename, policyname
FROM pg_policies
WHERE
    tablename IN ('users', 'expenses', 'trips');

