import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest } from "../src/api.js";

/** Catch-all Vercel Serverless Function entrypoint for all /api/* routes via vercel.json rewrites. */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  await handleApiRequest(req, res);
}
