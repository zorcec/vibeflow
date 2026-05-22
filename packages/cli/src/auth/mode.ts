import { readToken } from "./token.js";

export type Mode = "local" | "saas";

export async function getMode(): Promise<Mode> {
  const token = await readToken();
  return token ? "saas" : "local";
}
