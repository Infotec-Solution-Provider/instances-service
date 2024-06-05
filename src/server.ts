import app from "./app";
import yargs from "yargs";

const args = yargs.parse();
const port = parseInt(Object.entries(args)[0][1]) || 8000;

app.listen(port, () => console.log(`App is running on port ${port}`));
