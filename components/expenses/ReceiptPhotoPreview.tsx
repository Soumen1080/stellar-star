"use client";

import { useEffect, useState } from "react";

export function ReceiptPhotoPreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return <figure className="space-y-1">
    {url && <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open original receipt photo">
      {/* Local user-selected photo; object URL is revoked on discard. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Original receipt for field review" className="max-h-80 w-full rounded border object-contain" />
    </a>}
    <figcaption className="break-all text-xs">{file.name} — original photo. Tap to enlarge.</figcaption>
  </figure>;
}
