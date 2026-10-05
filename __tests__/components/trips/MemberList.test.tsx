/** @jest-environment jsdom */
import React from "react";
import { render, screen } from "@testing-library/react";
import { MemberList } from "@/components/trips/MemberList";
import type { Member } from "@/types/expense";

const ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ADDR_B = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";

describe("MemberList", () => {
  it("renders member names and canonical uppercase explorer links", () => {
    const members: Member[] = [
      { id: "1", name: "Alice", walletAddress: `  ${ADDR_A.toLowerCase()}  ` },
      { id: "2", name: "Bob", walletAddress: ADDR_B },
      { id: "3", name: "Charlie" },
    ];

    const { container } = render(<MemberList members={members} />);

    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText("Charlie")).toBeTruthy();

    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(2);

    // Explorer link for Alice must use canonical uppercase trimmed address
    expect(links[0].getAttribute("href")).toBe(
      `https://stellar.expert/explorer/testnet/account/${ADDR_A}`
    );
    expect(links[1].getAttribute("href")).toBe(
      `https://stellar.expert/explorer/testnet/account/${ADDR_B}`
    );
  });
});
