 /*
 * Copyright (C) 2015 Marcin Bychawski
 * All rights reserved.
 *
 * This software may be modified and distributed under the terms
 * of the BSD license.  See the LICENSE file for details.
 */
var SRClient = require('./SRClient').SRClient;
var localNodeNo = require("./config.json").localNodeNo;

var readline = require('readline');
var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

var nodeNo, name;

// rl.question("Node no: ", function(answer) {
    // nodeNo = +answer;
    nodeNo = localNodeNo;
    rl.question("Name: ", function(answer) {
        name = answer;
        var client = new SRClient(name, nodeNo);
        rl.close();
    });
// });
