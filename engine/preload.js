const { contextBridge } = require("electron");
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
contextBridge.exposeInMainWorld("peel", { token: arg("peel-token"), play: arg("peel-play") });
