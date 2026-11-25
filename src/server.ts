import dotenv from "dotenv";
dotenv.config();

import { app } from "./app.js";

const PORT = process.env.PORT || 3000;

export const server = app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
});
