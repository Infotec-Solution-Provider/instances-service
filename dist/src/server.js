"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
require("dotenv/config");
const port = Number(process.env.LISTEN_PORT) || 8000;
app_1.default.listen(port, () => console.log(`App is running on port ${port}`));
//# sourceMappingURL=server.js.map