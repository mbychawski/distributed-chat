 /*
 * Copyright (C) 2015 Marcin Bychawski
 * All rights reserved.
 *
 * This software may be modified and distributed under the terms
 * of the BSD license.  See the LICENSE file for details.
 */
var minPriority = 1;
var colors = require('colors');

// priority - 0 is always displayed, greater number, less important message
exports.log = function(text, indent, priority, nodeNo) {
    if( indent === undefined ) indent = 0;
    if( priority === undefined ) priority = 0;
    nodeNoStr = (nodeNo !== undefined) ? 'NODE-'+nodeNo+': ' : '';

    if( priority <= minPriority ) {
        var strInd = '';
        for(var i = 0; i < indent; i++) {
            strInd += ' ';
        }
        text = strInd + nodeNoStr + text;

        switch(nodeNo) {
            case 0: text = text.yellow;  break;
            case 1: text = text.green;   break;
            case 2: text = text.magenta; break;
            case 2: text = text.magenta; break;
        }
        process.stdout.write('\r');
        console.log( text );
    }
}

exports.setMinPriority = function( newValue ) {
    minPriority = newValue;
}