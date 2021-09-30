'use strict';

const net = require('net');
const EventEmitter = require('events');

const { current: log } = require('./logger');
const { Message, Messages } = require('./parser');

const PeerReconnectDelay = 1000; // 1 sec

class Mesh extends EventEmitter {
    constructor(name, peers, sessions) {
        super();
        this.peerName = name;
        this.peers = peers;
        this.sessions = sessions;
    }

    accept(socket) {
        log.info(`Peer connected`, socket);

        socket
            .on('error', (err) => {
                log.error(`Peer connection failed: ${err.message.substr(0, 64)}`, socket);

                this.emit('failed', socket.peer);

                socket.end();
                setImmediate(() => {
                    socket.removeAllListeners();
                    socket.on('error', function () {});
                    socket.destroy();
                    socket.peer = null;
                });
            })
            .on('end', () => {
                log.info(`Peer disconnected`, socket);

                this.emit('disconnected', socket.peer);

                setImmediate(() => {
                    socket.removeAllListeners();
                    socket.on('error', function () {});
                    socket.peer = null;
                });
            })
            .on('data', (data) => {
                log.debug(`Data chunk received: ${data.length}`, socket.peer);

                const session = this.sessions.get(socket.peer);
                data = session ? Buffer.concat([session.buffer, data]) : data;

                const msg = Message.parse(data);
                log.info(`Peer message: ${Messages[msg.type]} > ${msg.data || ''}`, socket);

                // expect hello message to fit in buffer
                if (!msg && !session) {
                    return;
                }
                if (!msg) {
                    session.buffer = data;
                    return;
                }

                // handle hello (connect peer)
                if (msg.type === Messages.Hello) {
                    if (!msg.data) {
                        socket.end();
                        return;
                    }

                    const payload = JSON.parse(msg.data);
                    socket.peer = this.peers[payload.name];

                    this.emit('connected', socket.peer, socket);
                }

                // handle bye (disconnect peer)
                else if (msg.type === Messages.Bye) {
                    socket.end();
                    return;
                }

                // handle election
                else {
                    if (!socket.peer) {
                        socket.end();
                        return;
                    }

                    this.emit('message', socket.peer, msg);
                }

                this.sessions.get(socket.peer).buffer = msg.tail;

                // try parse next message
                if (msg.tail) {
                    setImmediate(() => socket.emit('data', Buffer.alloc(0)));
                }
            })
            .setNoDelay(true);
    }

    connect() {
        for (const peer of this.peers) {
            // initiate connection to leader candidates only
            if (this.peerName >= peer.name) {
                continue;
            }
            this.connectPeer(peer);
        }
    }

    connectPeer(peer) {
        const address = peer.address.split(':');
        const socket = net
            .createConnection(address[1], address[0], () => {
                log.info(`Connected peer`, socket);

                socket.write(
                    Message.build(
                        Messages.Hello,
                        JSON.stringify({
                            name: this.peerName,
                        }),
                    ),
                    () => this.emit('connected', socket.peer, socket),
                );
            })
            .on('error', (err) => {
                log.error(`Connecting peer failed: ${err.message.substr(0, 64)}`, socket);

                this.emit('failed', socket.peer);

                socket.end();
                setImmediate(() => {
                    socket.removeAllListeners();
                    socket.on('error', function () {});
                    socket.destroy();
                    socket.peer = null;
                });

                setTimeout(() => {
                    this.connectPeer(peer);
                }, PeerReconnectDelay);
            })
            .on('end', () => {
                log.info(`Peer disconnected`, socket);

                this.emit('disconnected', socket.peer);

                setImmediate(() => {
                    socket.removeAllListeners();
                    socket.on('error', function () {});
                    socket.peer = null;
                });

                setTimeout(() => {
                    this.connectPeer(peer);
                }, PeerReconnectDelay);
            })
            .on('data', (data) => {
                const session = this.sessions.get(socket.peer);
                data = Buffer.concat([session.buffer, data]);

                const msg = Message.parse(data);
                log.info(`Peer message: ${Messages[msg.type]} > ${msg.data || ''}`, socket);

                if (!msg) {
                    session.buffer = data;
                    return;
                }

                this.emit('message', socket.peer, msg);

                session.buffer = msg.tail;

                // try parse next message
                if (msg.tail) {
                    setImmediate(() => socket.emit('data', Buffer.alloc(0)));
                }
            })
            .setNoDelay(true);

        socket.peer = peer;

        log.info(`Connecting peer`, socket);
    }

    disconnect() {
        for (const peer of this.peers) {
            if (this.peerName === peer.name) {
                continue;
            }
            this.disconnectPeer(peer);
        }
    }

    disconnectPeer(peer) {
        const session = this.sessions.get(peer);
        if (!session) {
            return;
        }

        const socket = session.socket;
        socket.end();
        socket.removeAllListeners();
        socket.on('error', function () {});
        socket.destroy();
        socket.peer = null;

        this.emit('disconnected', peer);
    }
}

module.exports.Mesh = Mesh;
