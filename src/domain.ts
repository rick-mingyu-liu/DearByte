export type Role = "user" | "assistant";

export type StoredMessage = {
  id: number;
  role: Role;
  text: string;
  bubbles: string[] | null; // assistant replies only
  hasImage: boolean;
  createdAt: string; // UTC ISO
};

export const FACT_CATEGORIES = ["profile", "preference", "event", "person", "pet", "shared"] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export type Fact = {
  id: number;
  category: FactCategory;
  key: string;
  value: string;
  eventDate: string | null; // YYYY-MM-DD in the user's time zone
  evidence: string; // verbatim quote from the user's message
  sourceMessageId: number | null; // null once history is cleared
  createdAt: string;
  updatedAt: string;
};

export type FactCandidate = {
  category: FactCategory;
  key: string;
  value: string;
  eventDate: string | null;
  evidence: string;
};

export type ImageInput = { mimeType: string; bytes: Uint8Array };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};
