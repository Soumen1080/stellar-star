/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import TripsPage from "@/app/trips/page";
import { useTrip, useTripSearch } from "@/hooks/useTrip";
import { useExpense } from "@/hooks/useExpense";
import { useAuth } from "@/context/AuthContext";
import { useWallet } from "@/hooks/useWallet";

// Mock the hooks
jest.mock("@/hooks/useTrip");
jest.mock("@/hooks/useExpense");
jest.mock("@/context/AuthContext");
jest.mock("@/hooks/useWallet");

// Mock next/link
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}));

// Mock AuthGuard so it just renders children
jest.mock("@/components/auth/AuthGuard", () => ({
  AuthGuard: ({ children }: any) => <>{children}</>,
}));

// Mock useToast
jest.mock("@/components/ui/Toast", () => ({
  useToast: () => ({
    success: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock the modal
jest.mock("@/components/ui/Modal", () => ({
  Modal: ({ open, children }: any) => (open ? <div>{children}</div> : null),
}));

const mockUseTrip = useTrip as jest.Mock;
const mockUseTripSearch = useTripSearch as jest.Mock;
const mockUseExpense = useExpense as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;
const mockUseWallet = useWallet as jest.Mock;

describe("TripsPage State Transitions", () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: { displayName: "Test User" } });
    mockUseWallet.mockReturnValue({ publicKey: "G12345" });
    mockUseExpense.mockReturnValue({ expenses: [] });
    mockUseTripSearch.mockImplementation(() => {
      const data = mockUseTrip() ?? {};
      return {
        trips: [],
        allTrips: [],
        totalTrips: 0,
        addTrip: jest.fn(),
        deleteTrip: jest.fn(),
        isLoading: false,
        isOffline: false,
        ...data,
      };
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("renders a loading spinner when isLoading is true", () => {
    mockUseTrip.mockReturnValue({
      trips: [],
      addTrip: jest.fn(),
      deleteTrip: jest.fn(),
      isLoading: true,
      isOffline: false,
    });

    render(<TripsPage />);
    
    // Check that empty state is NOT there
    expect(screen.queryByText(/Create a trip to group expenses/i)).toBeNull();
    
    // Check if offline notice is absent
    expect(screen.queryByText(/offline data/i)).toBeNull();
  });

  it("renders the empty state when not loading and trips are empty", () => {
    mockUseTrip.mockReturnValue({
      trips: [],
      addTrip: jest.fn(),
      deleteTrip: jest.fn(),
      isLoading: false,
      isOffline: false,
    });

    render(<TripsPage />);
    
    expect(screen.getByText(/Create a trip to group expenses/i)).toBeTruthy();
  });

  it("renders the offline fallback notice when isOffline is true", () => {
    mockUseTrip.mockReturnValue({
      trips: [],
      addTrip: jest.fn(),
      deleteTrip: jest.fn(),
      isLoading: false,
      isOffline: true,
    });

    render(<TripsPage />);
    
    expect(screen.getByText(/You are currently viewing offline data/i)).toBeTruthy();
  });
});
