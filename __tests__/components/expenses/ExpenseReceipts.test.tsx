/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExpenseReceipts } from "@/components/expenses/ExpenseReceipts";
import * as client from "@/lib/receipts/client";
import { RECEIPT_ACCEPT } from "@/lib/receipts/policy";

jest.mock("@/lib/receipts/client", () => {
  const actual = jest.requireActual("@/lib/receipts/client");
  return {
    ...actual,
    listExpenseReceipts: jest.fn(),
    uploadExpenseReceipt: jest.fn(),
    removeExpenseReceipt: jest.fn(),
    prepareReceiptFile: jest.fn(async (file: File) => ({ blob: file, fileName: file.name })),
  };
});

const mocked = client as jest.Mocked<typeof client>;
const PAYER = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";

describe("ExpenseReceipts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mocked.listExpenseReceipts.mockResolvedValue([]);
  });

  it("offers a rear-camera capture and a file picker to the payer on mobile", async () => {
    render(<ExpenseReceipts expenseId="e1" canUpload currentUserPublicKey={PAYER} />);
    await screen.findByText("No receipts attached.");

    const camera = screen.getByLabelText("Take a photo of the receipt") as HTMLInputElement;
    expect(camera.type).toBe("file");
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.getAttribute("accept")).toBe("image/*");

    const picker = screen.getByLabelText("Choose a receipt file") as HTMLInputElement;
    expect(picker.getAttribute("accept")).toBe(RECEIPT_ACCEPT);
    expect(picker.hasAttribute("capture")).toBe(false);
  });

  it("uploads a captured photo with its caption", async () => {
    mocked.uploadExpenseReceipt.mockResolvedValue({
      id: "r1",
      expenseId: "e1",
      fileName: "image.jpg",
      contentType: "image/jpeg",
      sizeBytes: 10,
      checksum: "a".repeat(64),
      caption: "Taxi",
      status: "active",
      uploadedByWallet: PAYER,
      createdAt: "2026-10-01T00:00:00.000Z",
      retainUntil: "2028-10-01T00:00:00.000Z",
      removedAt: null,
    });
    render(<ExpenseReceipts expenseId="e1" canUpload currentUserPublicKey={PAYER} />);
    await screen.findByText("No receipts attached.");

    fireEvent.change(screen.getByLabelText("Receipt caption (optional)"), { target: { value: "Taxi" } });
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff])], "image.jpg", { type: "image/jpeg" });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Take a photo of the receipt"), { target: { files: [photo] } });
    });

    await waitFor(() =>
      expect(mocked.uploadExpenseReceipt).toHaveBeenCalledWith("e1", photo, "image.jpg", "Taxi"),
    );
    expect(await screen.findByText("Receipt attached.")).toBeTruthy();
  });

  it("hides upload controls from members who did not pay", async () => {
    render(<ExpenseReceipts expenseId="e1" canUpload={false} currentUserPublicKey={PAYER} />);
    await screen.findByText("No receipts attached.");
    expect(screen.queryByLabelText("Take a photo of the receipt")).toBeNull();
  });

  it("explains access denial instead of showing an empty list", async () => {
    mocked.listExpenseReceipts.mockRejectedValue(new client.ReceiptRequestError("Expense not found.", 404));
    render(<ExpenseReceipts expenseId="e1" canUpload={false} currentUserPublicKey={PAYER} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/don't have access/);
  });
});
