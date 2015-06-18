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

var customLog = require('./customLog').log;

var nodesRing = require('./config.json').nodesRing;

exports.SRNode = SRNode;
function SRNode(nodeNo) {
    var self = this;

    this.nodeNo         = nodeNo;
    this.connectedNodes = {};
    this.localClients   = {};

    this.emitter        = new EventEmitter();

    this.resetNodesInterface();
    this.resetClientsInterface();
}

SRNode.prototype.resetNodesInterface = function() {
    var self = this;
    var deferred = Q.defer()

    if( this.nodesTcpServer ) {
        this.nodesTcpServer.close(function() {
            deferred.resolve();
        });
    }
    else deferred.resolve();

    _.each(this.connectedNodes, function(socket, remoteNodeNo) {
        socket.removeAllListeners();
        socket.destroy();
    });

    _.each(this.activeTimeouts, function(timeout) {
        clearTimeout( timeout.id );
    });

    this.ip               = nodesRing[ this.nodeNo ].host;
    this.nodesPort        = nodesRing[ this.nodeNo ].port;
    this.nodesTcpServer   = null;

    this.connectedNodes   = {};
    this.activeTimeouts   = [];

    this.elNo             = 0;
    this.serverNodeNo     = null;
    this.lastElMembers    = [];

    deferred.promise.then(function() {
        self.listenToNodes().then( function() {
            self.sendMessageToNode('election', {}, 'next');
        });
    });
}

SRNode.prototype.resetClientsInterface = function() {
    var self = this;
    var deferred = Q.defer();

    if( this.clientsTcpServer ) {
        this.clientsTcpServer.close(function() {
            deferred.resolve();
        });
    }
    else deferred.resolve();

    _.each(this.localClients, function(client, id) {
        if(client.socket) {
            client.socket.end();
        }
    });

    this.clientsPort       = nodesRing[ this.nodeNo ].clientsPort;
    this.clientsTcpServer  = null;

    this.localClients   = {};
    this.allClients     = [];

    deferred.promise.then(function() {
        self.listenToClients();
    });
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////    NODE - NODE COMMUNICATION     //////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

SRNode.prototype.listenToNodes = function() {
    var self = this;
    var deferred = Q.defer();

    this.nodesTcpServer = net.createServer( function( socket ) {
        customLog('Incoming connection from node #' + getNodeNoFromIp( socket.remoteAddress ), 0, 2, self.nodeNo);
        self.initNodeSocket( socket );
    });

    this.nodesTcpServer.on('listening', function() {
        customLog('Node #' + self.nodeNo + ' is listening at ' + self.ip + ':' + self.nodesPort, 0, 0, self.nodeNo);
        deferred.resolve();
    });

    this.nodesTcpServer.on('error', function(err) {
        deferred.reject(err);
    });

    this.nodesTcpServer.listen(self.nodesPort, self.ip);

    return deferred.promise;
}

SRNode.prototype.initNodeSocket = function( socket ) {
    var self = this;

    var remoteNodeNo = getNodeNoFromIp( socket.remoteAddress );

    this.connectedNodes[ remoteNodeNo ] = socket;

    socket.on('data', function(data) {
        try {
            data = data.toString();
            data = data.replace(/\}\{/g, '};{').split(';'); //sometimes there wait more than one message
            _.each(data, function(message) {
                message = JSON.parse(message);
                self.messageFromNode(message, remoteNodeNo);
            });
        }
        catch (err) {
            console.log(err);
            customLog('Received message from node #' + remoteNodeNo + ', but message syntax error', 0, 0, self.nodeNo);
        }
    });

    socket.on('close', function() {
        customLog('Connection with node #' + remoteNodeNo + ' closed.', 0, 1, self.nodeNo);
        delete self.connectedNodes[ remoteNodeNo ];

        self.tryToReconnectToNode( remoteNodeNo );
    });

    socket.on('error', function(err) {
        console.log(err);
        customLog('Error on socket to node #' + remoteNodeNo, 0, 0, self.nodeNo);
        socket.destroy();
    });
}

SRNode.prototype.tryToReconnectToNode = function( nodeNo ) {
    console.log('trying to reconnect to node', nodeNo);
    var self = this;
    self.getSocket( nodeNo ).then(function(result) {
        var socket = result[0];
        console.log('success');
        if( self.connectedNodes[nodeNo] === undefined ) {
            console.log('added');
            self.initNodeSocket( socket );
        }
    })
    .catch(function(reason) {
        console.log('reconnect unable');
        var nodeIp = nodesRing[ nodeNo ].host;
        if( self.serverNodeNo == nodeNo ) {
            self.serverNodeNo = null;
            self.sendMessageToNode('election', {}, 'next');
        }
        else if ( self.serverNodeNo == self.nodeNo ) {
            self.allClients = _.filter(self.allClients, function(client) {
                return client.node != nodeIp;
            });
        }
        else if (self.serverNodeNo !== null) {
            self.sendMessageToNode('node-down', {ip: nodeIp}, self.serverNodeNo);
        }
    });
}

SRNode.prototype.messageFromNode = function(message, remoteNodeNo) {
    var self = this;
    customLog('Message ' + message.type + ' from node #' + remoteNodeNo, 0, 1, self.nodeNo);
    console.log('R-->', remoteNodeNo, message);
    self.stopMessageTimeout(message, remoteNodeNo);
    switch( message.type ) {
        case 'election' :
            self.analizeIncomingElection(message, remoteNodeNo);
            break;
        case 'election-done' :
            self.analizeIncomingElectionDone(message, remoteNodeNo);
            break;
        case 'election-break' :
            self.elNo = message.elNo;
            self.serverNodeNo = getNodeNoFromIp( message.server );
            customLog('!!!!!!ELECTION nr ' + self.elNo + ' DONE. SERVER NODE: #' + self.serverNodeNo, 0, 0, self.nodeNo);
            self.informServerAboutUpdate();
            break;
        case 'clients-list' :
            self.allClients = message.clients;
            self.emitter.emit('clientsListUpdated', message.clients);
            break;
        case 'node-update' :
            self.analizeIncomingNodeUpdate(message.clients, remoteNodeNo);
            break;
        case 'get-clients' :
            self.sendMessageToNode('clients-list', {clients: self.allClients}, remoteNodeNo);
            break;
        case 'ping' :
            self.informServerAboutUpdate(remoteNodeNo);
            break;
        case 'message' :
        case 'message-ack' :
        case 'message-fail' :
            self.sendMessageToClient(message, message['client-to'].id);
            break;
        case 'node-down' :
            self.tryToReconnectToNode( getNodeNoFromIp( message.ip ) );
            break;
    }
}

SRNode.prototype.analizeIncomingElection = function(message, remoteNodeNo) {
    var self = this;

    var members = message.members;
    var membersToBreak = [];
    if(self.serverNodeNo !== null) {
        var membersToBreak = _.filter(members, function(member) {
            var earlierEllection                 = member.elNo < self.elNo;
            return earlierEllection;
        });
    }

    var amIInMembers = _.find(members, {ip: self.ip}) !== undefined;

    if( membersToBreak.length > 0 ) {
        _.each(membersToBreak, function(member) {
            self.sendMessageToNode('election-break', {}, getNodeNoFromIp( member.ip ));
        });
    }
    else {
        if( amIInMembers ) {

            self.afterElection(members, self.elNo + 1);

            members[0].received = true;
            members[0].elNo = self.elNo;
            self.sendMessageToNode('election-done', {members: members}, getNodeNoFromIp( members[1].ip ));
        }
        else {
            self.sendMessageToNode('election', {members: members}, 'next');
        }
        self.sendMessageToNode('election-ack', {}, remoteNodeNo);
    }
}

SRNode.prototype.analizeIncomingElectionDone = function(message, remoteNodeNo) {
    var self = this;

    var members = message.members;

    var myIndexInMembers  = _.indexOf(members, _.findWhere(members, { ip: self.ip } ) );
    var nextIpFromMembers = members[ (myIndexInMembers + 1 ) % members.length ].ip;


    if(self.lastElMembers.length > members.length || message.elNo < self.elNo) {
        self.sendMessageToNode('election-break', {}, remoteNodeNo);
    }
    else {
        if( members[0].ip != self.ip ) {
            self.afterElection(members, message.elNo);

            members[myIndexInMembers].received = true;
            members[myIndexInMembers].elNo = self.elNo;

            self.sendMessageToNode('election-done', {members: members}, getNodeNoFromIp( nextIpFromMembers ));
        }
        self.sendMessageToNode('election-done-ack', {}, remoteNodeNo);
    }
}

SRNode.prototype.afterElection = function(members, newElNo) {
    var self = this;


    var newElNo           = newElNo;
    var newLastElMembers  = _.clone(members);
    var newServerNodeNo   = getElectionWinner(members);

    if( newElNo > this.elNo || newServerNodeNo != this.serverNodeNo ) {
        this.elNo           = newElNo;
        this.lastElMembers  = newLastElMembers;
        this.serverNodeNo   = newServerNodeNo;

        customLog('!!!!!!ELECTION nr ' + this.elNo + ' DONE. SERVER NODE: #' + this.serverNodeNo, 0, 0, this.nodeNo);
        self.emitter.emit('election-done');

        if(this.serverNodeNo == this.nodeNo) {
            self.allClients = [];
            self.informServerAboutUpdate();
            _.each(this.lastElMembers, function(member) {
                if(member.ip == self.ip)
                    return;
                var memberNo = getNodeNoFromIp( member.ip );

                self.sendMessageToNode('ping', {}, memberNo);
            });
        }
    }


}

SRNode.prototype.analizeIncomingNodeUpdate = function(clients, remoteNodeNo) {
    var self = this;

    if(self.serverNodeNo != self.nodeNo)
        return;

    self.allClients = _.filter(self.allClients, function(client) {
        return client.node != nodesRing[remoteNodeNo].host;
    });

    _.each(clients, function(client) {
        self.allClients.push( _.extend(client, {node: nodesRing[remoteNodeNo].host}) );
    });

    self.sendMessageToNode('node-update-ack', {}, remoteNodeNo);
}

SRNode.prototype.informServerAboutUpdate = function(tmpServerNo) {
    var self = this;
    var clients = _.pluck( _.values( self.localClients ), 'clientInfo');

    if(tmpServerNo !== undefined) {
        self.sendMessageToNode('node-update', {clients: clients}, tmpServerNo);
    }
    else if( self.serverNodeNo !== null ) {
        if( self.serverNodeNo == self.nodeNo ) {
            self.analizeIncomingNodeUpdate(clients, self.nodeNo);
        }
        else {
            self.sendMessageToNode('node-update', {clients: clients}, self.serverNodeNo).catch(function() {
                self.tryToReconnectToNode( self.serverNodeNo );
            });
        }
    }
}

SRNode.prototype.sendMessageToNode = function(messageType, options, remoteNode) {
    var self = this;
    var deferred = Q.defer();

    var message = {
        type: messageType,
        elNo: self.elNo
    };

    message = _.extend(message, options);

    switch( messageType ) {
        case 'election' :
            if( message.members === undefined ) {
                message.members = [];
            }
            message.members.push({
                ip: self.ip,
                elNo: self.elNo
            });
            break;

        case 'election-break' :
            message.server = nodesRing[ self.serverNodeNo ].host;
            break;
    }
    var messageStr = JSON.stringify( message );

    this.getSocket( remoteNode ).then( function( result ) {
        var socket = result[0];
        var remoteNodeNo = result[1];
        socket.write( messageStr );

        customLog('Message ' + messageType + ' sent to node ' + remoteNodeNo, 0, 1, self.nodeNo);
        console.log('S-->',remoteNodeNo, message);
        self.startMessageTimeout(message, remoteNodeNo);

        deferred.resolve();
    }).catch( function( reason ) {
        customLog('Message wasn\'t sent. Cause: ' + reason, 0, 0, self.nodeNo);
        deferred.reject( reason );
    });

    return deferred.promise;
}

SRNode.prototype.startMessageTimeout = function(message, remoteNodeNo) {
    var self = this;
    var waitFor = null;
    switch( message.type ) {
        // case 'election'     : waitFor = 'election-ack-'      + remoteNodeNo; break; //or election-break
        // case 'node-update'  : waitFor = 'node-update-ack-'   + remoteNodeNo; break;
        case 'get-clients'  : waitFor = 'clients-list-'      + remoteNodeNo; break;
        case 'message'      : waitFor = 'message-ack-'       + remoteNodeNo; break; //or message-fail
        case 'ping'         : waitFor = 'node-update-'       + remoteNodeNo; break;
    }
    if( waitFor !== null ) {
        var timeoutId = setTimeout(function() {

            var timeout         = _.find(self.activeTimeouts, {name: waitFor});
            self.activeTimeouts = self.activeTimeouts.slice( self.activeTimeouts.indexOf( timeout ) );

            // self.getSocket( remoteNodeNo ).then(function(result) {
            //     var socket = result[0];

            //     socket.destroy();
            // });

        }, 3000);

        this.activeTimeouts.push( {name: waitFor, id: timeoutId} );
    }
}

SRNode.prototype.stopMessageTimeout = function(message, remoteNodeNo) {
    var self = this;
    var timeoutName = message.type + '-';
    if( message.type == 'message-fail' ) timeoutName = 'message-ack-';
    if( message.type == 'election-break' ) timeoutName = 'election-done-';
    timeoutName = timeoutName + remoteNodeNo;

    var timeout = _.find(self.activeTimeouts, {name: timeoutName});
    if( timeout === undefined )
        return;

    self.activeTimeouts = self.activeTimeouts.slice( self.activeTimeouts.indexOf( timeout ) );

    var timeoutId = timeout.id;
    if( timeoutId === undefined )
        return;

    clearTimeout( timeoutId );
    // customLog('Timeout for ' + timeoutName + ' desactivated :D',0,0,self.nodeNo);
}

SRNode.prototype.getSocket = function(nodeNumber) {
    var self     = this;
    var emitter  = new EventEmitter();
    var deferred = Q.defer();

    var i = 0; //iterator used in finding next avaliable node

    customLog('Getting socket: ' + nodeNumber, 0, 2, self.nodeNo);

    emitter.on('next', function() {
        if(electionDone) {
            deferred.reject('...');
            return;
        }
        i = i + 1;
        if( i >= nodesRing.length ) {
            customLog('Last node in ring checked and faild. You are alone.', 2, 0, self.nodeNo);
            self.elNo = 0;
            self.serverNodeNo = null;
            deferred.reject('You are alone.');
            return;
        }
        customLog('Getting next node in ring. i = ' + i, 1, 3, self.nodeNo);
        emitter.emit('connect', (self.nodeNo + i) % nodesRing.length);
    });

    emitter.on('connect', function(nodeNo) {
        customLog('Trying to connnect to node #' + nodeNo, 2, 3, self.nodeNo);

        if( !_.isNumber(nodeNo) || nodeNo < 0 || nodeNo >= nodesRing.length || nodeNo == self.nodeNo ) {
            deferred.reject('Wrong node number.');
            return;
        }

        if( self.connectedNodes[ nodeNo ] !== undefined ) {
            customLog('Connection is open. Getting existing reference.', 2, 3, self.nodeNo);
            deferred.resolve( [self.connectedNodes[nodeNo], nodeNo] );
            return;
        }

        customLog('Creating new connnection.', 2, 3, self.nodeNo);

        var socket = net.createConnection( _.extend( nodesRing[ nodeNo ], { localAddress: self.ip } ), function() {
                customLog('Connection to node #'+nodeNo+' established.', 2, 2, self.nodeNo);

                self.initNodeSocket( socket );
                console.log('I created connection', nodeNo);
                deferred.resolve( [socket, nodeNo] );
                nodeNumber = 'OK!'; //in case of error, it will not try to connect to next node
        });

        socket.on('error', function localErrCallback(err) {
            if(nodeNumber == 'next') {
                customLog('Node #' + (self.nodeNo + i) % nodesRing.length + ' is not responding', 1, 1, self.nodeNo);
                emitter.emit('next');
            }
            else {
                deferred.reject('Node #', nodeNumber, ' isn\'t responding.');
            }
        });
        deferred.promise.finally(function() {
            socket.removeListener('error', localErrCallback);
        });
    });

    if( nodeNumber == 'next' ) {
        //it is for special case, when ellection was done while node wanted to start new election
        var electionDone = false;
        this.emitter.once('election-done', function() {
            electionDone = true;
        });
        emitter.emit('next');
    }
    else {
        emitter.emit('connect', nodeNumber);
    }

    deferred.promise.finally(function() {
        emitter.removeAllListeners();
        self.emitter.removeAllListeners('election-done');
    });

    return deferred.promise;
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////    NODE - CLIENT COMMUNICATION     ////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

SRNode.prototype.listenToClients = function() {
    var self     = this;
    var deferred = Q.defer();

    this.clientsTcpServer = net.createServer( function( socket ) {
        customLog('New client connected', 0, 1, self.nodeNo);

        self.initClientSocket( socket );
    });

    this.clientsTcpServer.listen(self.clientsPort, 'localhost');

    this.clientsTcpServer.on('listening', function() {
        customLog('Node #' + self.nodeNo + ' is listening for clients at localhost:' + self.clientsPort, 0, 0, self.nodeNo);
        deferred.resolve();
    });

    this.clientsTcpServer.on('error', function(err) {
        deferred.reject(err);
    });

    return deferred.promise;
}

SRNode.prototype.initClientSocket = function( socket ) {
    var self = this;

    var clientInfo = null;

    socket.on('data', function(data) {
        try {
            data = data.toString();
            data = data.replace(/\}\{/g, '};{').split(';'); //sometimes there wait more than one message

            _.each(data, function(message) {
                message = JSON.parse(message);

                if( message.type == 'connect' ) {
                    clientInfo = {
                        id : message.id,
                        name: message.name
                    };

                    self.localClients[clientInfo.id] = {
                        clientInfo: clientInfo,
                        socket: socket
                    };

                    self.informServerAboutUpdate();

                    customLog('Client ' + clientInfo.name + ' registred in node.', 0, 0, self.nodeNo);
                }
                else {
                    self.messageFromClient(message, clientInfo);
                }

            });
        }
        catch (err) {
            customLog(err,0,0,self.nodeNo);
            customLog('Received message from client, but message syntax error', 0, 0, self.nodeNo);
        }
    });

    socket.on('close', function() {
        customLog('Connection with client closed.', 0, 1, self.nodeNo);
        if(clientInfo !== null) {
            delete self.localClients[clientInfo.id];
            self.informServerAboutUpdate();
        }
    });
}

SRNode.prototype.messageFromClient = function(message, client) {
    var self = this;
    switch( message.type ) {
        case 'get-clients' :
            this.prepareClientsList().then(function(list) {

                self.prepareAndSendMessageToClient('clients-list', {clients: list}, client.id);
            });
            break;

        case 'message' :
        case 'message-ack':
            self.routeMessage(message, client);
            break;
    }
}

SRNode.prototype.routeMessage = function(message) {
    var self = this;
    var destId = message['client-to'].id;

    if( this.localClients[ destId ] !== undefined ) {
        this.sendMessageToClient(message, destId);
    }
    else {
        if( findAndSend() ){
            return;
        }
        else {
            self.prepareClientsList().then(function() {
                if( findAndSend() ){
                    return;
                }
                else {
                    var failMessage = {
                        type: 'message-fail',
                        'client-to'   : message['client-from'],
                        'client-from' : message['client-to'],
                        timestamp: message.timestamp
                    }
                    self.routeMessage(failMessage);
                }
            });
        }
    }

    function findAndSend() {
        var dest = _.findWhere(self.allClients, {id: destId});
        if( dest !== undefined ) {
            self.sendMessageToNode(message.type, message, getNodeNoFromIp( dest.node ) );
            return true;
        }
        return false;
    }
}

SRNode.prototype.prepareAndSendMessageToClient = function(messageType, options, destClientId) {
    var self = this;

    var message = {
        type: messageType
    }

    message = _.extend(message, options);

    self.sendMessageToClient(message, destClientId);
}

SRNode.prototype.sendMessageToClient = function(message, destClientId) {
    var messageStr = JSON.stringify( message );
    var destClient = this.localClients[destClientId];

    if( destClient !== undefined ){
        var clientSocket = destClient.socket;
        clientSocket.write( messageStr );
        customLog('Message '+ message.type +' to client sent.', 0, 1, this.nodeNo);
    }
    else {
        var failMessage = {
            type: 'message-fail',
            'client-to'   : message['client-from'],
            'client-from' : message['client-to'],
            timestamp: message.timestamp
        }
        this.routeMessage(failMessage);
    }
}

SRNode.prototype.prepareClientsList = function() {
    var deferred = Q.defer();
    var self = this;

    if(self.serverNodeNo === null) {
        var clientsList = _.pluck( _.values(self.localClients), 'clientInfo' );
        deferred.resolve( clientsList );
    }
    else {
        if( self.serverNodeNo == self.nodeNo ) {
            deferred.resolve( self.allClients );
        }
        else {
            self.emitter.once('clientsListUpdated', function(clients) {
                deferred.resolve(clients);
            });
            self.sendMessageToNode('get-clients', {}, self.serverNodeNo);
        }
    }

    return deferred.promise;
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////    HELPERS     ////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function getNodeNoFromIp( ip ) {
    return _.indexOf(nodesRing, _.findWhere(nodesRing, { host: ip } ) ) ;
}

function getElectionWinner( members ) {
    function dot2num(dot)
    {
        var d = dot.split('.');
        return ((((((+d[0])*256)+(+d[1]))*256)+(+d[2]))*256)+(+d[3]);
    }

    var winner = _.max(members, function(member) {
        return dot2num(member.ip);
    });

    return getNodeNoFromIp( winner.ip );
}
