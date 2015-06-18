 /*
 * Copyright (C) 2015 Marcin Bychawski
 * All rights reserved.
 *
 * This software may be modified and distributed under the terms
 * of the BSD license.  See the LICENSE file for details.
 */
var Q            = require('q');
var net          = require('net');
var _            = require('underscore');
var uuid         = require('node-uuid');
var EventEmitter = require('events').EventEmitter;
var UUID         = require('node-uuid');
var colors       = require('colors');
var moment       = require('moment');
var readline     = require('readline');

var nodesRing = require('./config.json').nodesRing;
var customLog = require('./customLog').log;

exports.SRClient = SRClient;
function SRClient(name, node) {
    var self = this;

    this.id   = UUID.v1();
    this.name = name;

    this.socket = null;
    this.clientsList = [];
    this.emitter = new EventEmitter();

    this.connectToNode( node ).then(function() {
        self.sendMessage('connect');
        self.sendMessage('get-clients');
        self.startUserInterface();
    })
    .catch(function(err) {
        console.log(err);
    });

}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////    HUMAN INTERFACE     ////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

SRClient.prototype.startUserInterface = function() {
    var self = this;
    var rl = readline.createInterface(process.stdin, process.stdout);

    rl.setPrompt(self.name + '> ');

    rl.on('line', function(line) {
        line = line.trim();
        if( line[0] == 'L' || line[0] == 'l' ) {
            self.sendMessage('get-clients');
            self.emitter.once('clientsList-updated', function() {
                self.printClientsList();
            });
        }
        else if(line[0] == 'S' || line[0] == 's') {
            var clientNo = line.slice(1, line.indexOf(' '));
            var message  = line.slice(line.indexOf(' ')+1);
            self.sendMessage('message', {message: message}, clientNo);
            rl.prompt();
        }
        else {
            self.printAndPrompt('L <-- show clients list || S{nr} {message} <-- send message to client || Ctrl+C <-- exit');
        }
    }).on('close', function() {
        console.log('\n');
        process.exit(0);
    });

    self.emitter.on('prompt', function() {
        rl.prompt();
    });

    self.printAndPrompt('L <-- show clients list || S{nr} {message} <-- send message to client || Ctrl+C <-- exit');
}

SRClient.prototype.displayMessage = function( message ) {
    var self = this;
    var from = message['client-from'].name;
    var time = ' (' + moment( message.timestamp ).format('HH:mm:ss') + '): ';
    var text = message.message;

    self.printAndPrompt(from.green + time.red + text);
}

SRClient.prototype.printClientsList = function() {
    var self = this;
    var list = this.clientsList;
    self.printAndPrompt('\n AVALIABLE CLIENTS:'.magenta);
    _.each(list, function(client, i) {
        self.printAndPrompt('   ' + i + ') ' + client.name);
    });
    self.printAndPrompt('           ');

}

SRClient.prototype.printAndPrompt = function( text ) {
    process.stdout.write('\r                                                                \r');
    console.log(text);
    this.emitter.emit('prompt');
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////    NODE COMMUNICATION     /////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

SRClient.prototype.connectToNode = function( node ) {
    var self     = this;
    var deferred = Q.defer();

    var host = 'localhost';
    var port = nodesRing[ node ].clientsPort;

    var socket = this.socket = net.createConnection({
        host: host,
        port: port,
        localAddress: host
    }, function() {
        socket.on('data', function(data) {
            try {
                data = data.toString();
                data = data.replace(/\}\{/g, '};{').split(';'); //sometimes there wait more than one message
                _.each(data, function(message) {
                    message = JSON.parse(message);
                    self.incommingMessage(message);
                });
            }
            catch (err) {
                console.log(err);
            }
        });

        socket.on('close', function() {
            self.printAndPrompt('Connection with node closed.');
            process.exit(0);
        });

        deferred.resolve();
    });

    socket.on('error', function(err) {
        deferred.reject('Node #' + node +' isn\'t responding.');
    });

    return deferred.promise;
}

SRClient.prototype.incommingMessage = function( message ) {
    var self = this;
    switch( message.type ) {
        case 'clients-list' :
            this.clientsList = message.clients;
            this.emitter.emit('clientsList-updated', message.clients);
            break;
        case 'message' :
            self.displayMessage( message );
            self.sendMessageAck( message );
            break;
        case 'message-ack' :
            self.printAndPrompt('ack.');
            break;
        case 'message-fail' :
            self.printAndPrompt('message to ' + message['client-from'].name + ' failed.');
            break;
    }
}

SRClient.prototype.sendMessage = function( messageType, options, destination ) {
    var self = this;
    var destClient;

    var message = {
        type: messageType
    }

    message = _.extend(message, options);
    if(destination !== undefined) {
        destClient = self.clientsList [ destination ];
        if (destClient === undefined) {
            self.printAndPrompt('Wrong client No!');
            return;
        }
    }

    switch( messageType ) {
        case 'connect' :
            message.id = self.id;
            message.name = self.name;
            break;

        case 'message' :
            message['client-from'] = {
                id : self.id,
                name : self.name
            };
            message['client-to'] = destClient;
            message.timestamp = new Date().getTime();
            break;
    }

    var messageStr = JSON.stringify( message );

    self.socket.write( messageStr );
}

SRClient.prototype.sendMessageAck = function( originalMsg ) {
    var message = {
        'client-to'  : originalMsg['client-from'],
        'client-from': originalMsg['client-to'],
        timestamp : originalMsg.timestamp
    };

    this.sendMessage('message-ack', message);
}
