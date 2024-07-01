import app from "./app";
import "dotenv/config";

const port = Number(process.env.LISTEN_PORT) || 8000;

app.listen(port, () => console.log(`App is running on port ${port}`));
