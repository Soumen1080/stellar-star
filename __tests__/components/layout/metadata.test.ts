jest.mock("@/app/globals.css", () => ({}));
jest.mock("next/font/google", () => ({
  Poppins: () => ({
    className: "poppins-mock",
  }),
}));

import fs from "fs";
import path from "path";
import { metadata } from "@/app/layout";

describe("Root Layout Metadata & Open Graph Image", () => {
  const publicDir = path.resolve(process.cwd(), "public");
  const ogImagePath = path.join(publicDir, "og-image.png");

  it("exports metadata with Open Graph configuration referencing /og-image.png at 1200x630", () => {
    expect(metadata.openGraph).toBeDefined();
    expect(metadata.openGraph?.images).toBeDefined();

    const ogImages = metadata.openGraph?.images;
    expect(Array.isArray(ogImages)).toBe(true);

    const ogImage = Array.isArray(ogImages) ? ogImages[0] : null;
    expect(ogImage).toEqual(
      expect.objectContaining({
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Stellar-star - Split Bills on Stellar",
      })
    );
  });

  it("exports metadata with Twitter card configuration referencing /og-image.png", () => {
    expect(metadata.twitter).toBeDefined();
    // `Metadata["twitter"]` is a union and only some members declare `card`,
    // so read it through a narrowed view rather than off the union directly.
    const twitter = metadata.twitter as { card?: string; images?: unknown } | null | undefined;
    expect(twitter?.card).toBe("summary_large_image");
    expect(twitter?.images).toEqual(["/og-image.png"]);
  });

  it("verifies public/og-image.png exists with valid PNG signature and 1200x630 dimensions", () => {
    expect(fs.existsSync(ogImagePath)).toBe(true);

    const buffer = fs.readFileSync(ogImagePath);
    // PNG file header starts with 89 50 4E 47 0D 0A 1A 0A
    const isPng =
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a;
    expect(isPng).toBe(true);

    // Read IHDR chunk width (bytes 16-19) and height (bytes 20-23) in big-endian
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);

    expect(width).toBe(1200);
    expect(height).toBe(630);
  });
});
