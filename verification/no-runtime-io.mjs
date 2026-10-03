import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const blocked = () => {
  throw new Error("Runtime network/server I/O is forbidden in client-only verification");
};
globalThis.fetch = async () => blocked();
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
net.Socket.prototype.connect = blocked;
net.Server.prototype.listen = blocked;
syncBuiltinESMExports();
