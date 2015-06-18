 /*
 * Copyright (C) 2015 Marcin Bychawski
 * All rights reserved.
 *
 * This software may be modified and distributed under the terms
 * of the BSD license.  See the LICENSE file for details.
 */
var SRNode = require("./SRNode").SRNode;

var localNodeNo = require("./config.json").localNodeNo;

var node = new SRNode(localNodeNo);
