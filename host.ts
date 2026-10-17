// Helm's host entry (V16). It runs inside each BB host daemon and does the git
// and filesystem work on the machine that owns the repositories. The plugin
// server never runs commands itself; it calls these methods by host id.

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { HOST_CONTRACT } from "./src/shared/host-contract.ts";
import { createHostOps } from "./src/host/ops.ts";

const ops = createHostOps();

export default experimental_defineHostEntry({
  contract: HOST_CONTRACT,
  handlers: {
    ensureRepo: (input) => ops.ensureRepo(input),
    inspectPath: (input) => ops.inspectPath(input),
    adoptRepo: (input) => ops.adoptRepo(input),
    revParse: (input) => ops.revParse(input),
    isAncestor: (input) => ops.isAncestor(input),
    fileAt: (input) => ops.fileAt(input),
    status: (input) => ops.status(input),
    readFile: (input) => ops.readFile(input),
    writeFile: (input) => ops.writeFile(input),
    log: (input) => ops.log(input),
    scan: (input) => ops.scan(input),
    probe: (input) => ops.probe(input),
  },
});
