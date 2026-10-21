/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { ReceiptPhotoPicker } from "@/components/expenses/ReceiptPhotoPicker";

test("opens capture only through an explicit rear camera input and allows file selection", () => {
  const onSelect = jest.fn();
  render(<ReceiptPhotoPicker onSelect={onSelect} disabled={false} />);
  const camera = screen.getByLabelText("Capture receipt for draft") as HTMLInputElement;
  const picker = screen.getByLabelText("Select receipt for draft");
  expect(camera.getAttribute("capture")).toBe("environment");
  expect(camera.accept).toBe("image/jpeg,image/png,image/webp");
  expect(picker.hasAttribute("capture")).toBe(false);
  expect(onSelect).not.toHaveBeenCalled();
  const file = new File(["photo"], "photo.jpg", { type: "image/jpeg" });
  fireEvent.change(camera, { target: { files: [file] } });
  expect(onSelect).toHaveBeenCalledWith(file);
  expect(camera.value).toBe("");
});
