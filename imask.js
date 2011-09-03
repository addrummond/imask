var net = require('net'),
    sys = require('sys'),
    util = require('util'),
    fs = require('fs'),
    ImapConnection = require('imap').ImapConnection,
    Seq = require('seq');

var IMAP_POLL_INTERVAL = 0.5 * 60 * 1000; // Milliseconds.

function getFirstWord(s) {
    var a = s.split(/\s+/);
    return [a[0], a.slice(1).join(' ')];
}

function parsePop(s) {
    var x = getFirstWord(s);
    var firstWord = x[0];
    var remainder = x[1];

    switch (firstWord) {
        case 'USER': case 'PASS': {
            var m = /^([^\s]+)\s*$/.exec(remainder);
            if (! m) {
                return "Bad '" + firstWord + "' command (" + s + ")";
            }
            else {
                return { command: firstWord, word: m[1] }
            }
        } break;
        case 'APOP': case 'CAPA': case 'NOOP': {
            return { command: firstWord }; // APOP not implemented so we don't bother parsing it properly.
        } break;
        case 'LIST': case 'RETR': case 'DELE': case 'UIDL': {
            var m = remainder.match(/^(\d+)\s*$/);
            if ((firstWord == "RETR" || firstWord == "DELE") && !m)
                return firstWord + " command requires message number";
            return { command: firstWord, messageNumber: m ? m[1] : undefined };
        } break;
        case 'RSET': case 'QUIT': case 'STAT': {
            return { command: firstWord };
        } break;
        default: {
            return "Bad or unimplemented command: " + s;
        }
    }
}

function closeSocketWithError(socket, error, callback) {
    Seq()
        .seq(function () { socket.write('+ERR ' + error + "\r\n", 'utf-8', this); })
        .seq(function () { socket.destroySoon(); callback(); })
        .catch(callback);
}

function getMessageOctetSize(message) {
    var header = 0;
    for (k in message.message.headers) {
        header += k.length + 4 /* ': ...\r\n' */ + new Buffer(message.message.headers[k]).length;
    }
    header += 2; // Final blank line.
    var lastWasR = false;
    var extras = 0;
    var body = new Buffer(message.body);
    for (var i = 0; i < body.length; ++i) {
        if (body[i] == '\r')
            lastWasR = true;
        else {
            if (body[i] == '\n' && !lastWasR)
                extras++;
            lasWasR = false;
        }
    }
    return header + new Buffer(body).length + extras;
}

function writeByteStuffed(socket, string, callback) {
    var lines = string.split('\n');
    Seq()
        .extend(lines)
        .forEach(function (line) {
            if (line.length && line.charAt(0) == '.') {
                socket.write('.' + line + '\n', this);
            }
            else {
                socket.write(line + '\n');
            }
        })
        .seq(function () { socket.write('\r\n.\r\n', this); })
        .seq(callback).catch(callback);
}

function dispatch(state, imapMessages, socket, p, callback) {
    function capa() {
        Seq().seq(function () {
            socket.write('+OK Capability list follows\r\nTOP\r\nUSER\r\nEXPIRE 1\r\nUIDL\r\n.\r\n', this);
        }).catch(callback);
    }

    if (state.state == 'waitinguser') {
        if (p.command == 'APOP') {
            Seq().seq(function () { socket.write('-ERR Not implemented\r\n', this); }).catch(callback);
        }
        else if (p.command == 'CAPA') {
            capa();
        }
        else {
            if (p.command != 'USER') {
                closeSocketWithError(socket, "Not authenticated", callback);
            }
            else if (p.word != opts.mboxname) {
                closeSocketWithError(socket, "No such mailbox", callback);
            }
            else {
                state.state = 'waitingpass';
                socket.write('+OK User ok\r\n', callback);
            }
        }
    }
    else if (state.state == 'waitingpass') {
        if (p.command == 'APOP' || p.command == 'CAPA') {
            Seq().seq(function () { socket.write('-ERR Not implemented\r\n', this); }).catch(callback);
        }
        else if (p.command == 'CAPA') {
            capa();
        }
        else {
            if (p.command != 'PASS') {
                closeSocketWithError(socket, "Not authenticated", callback);
            }
            else if (p.word != opts.popPassword) {
                closeSocketWithError(socket, "Not authenticated", callback);
            }
            else {
                state.state = 'authenticated';
                socket.write('+OK Authenticated\r\n', callback);
                console.log("User authenticated");
            }
        }
    }
    else if (state.state == 'authenticated') {
        switch (p.command) {
            case 'NOOP': {
                socket.write('+OK\r\n', callback);
            } break;
            case 'CAPA': {
                capa();
            } break;
            case 'LIST': {
                var ms = false;
                if (p.messageNumber)
                    ms = [p.messageNumber];
                else ms = Object.keys(imapMessages.messages);

                if (ms === false) {
                    socket.write('-ERR Bad message number\r\n');
                    callback("Bad message number");
                }
                else {
                    Seq()
                        .seq(function () { socket.write('+OK ' + Object.keys(imapMessages.messages).length + ' messages\r\n', this); })
                        .extend(ms)
                        .forEach(function (k, i) {
                            var message = imapMessages.messages[k];
                            socket.write(message.number + ' ' + getMessageOctetSize(message) + '\r\n', this);
                        })
                        .seq(function () { socket.write('.\r\n', this); })
                        .catch(callback);
                }
            } break;
            case 'RETR': {
                // TODO: Inefficient linear search; should be in a dictionary.
                var m = imapMessages.messages[p.messageNumber];
                if (! m) {
                    socket.write('-ERR Bad message number\r\n');
                    callback("Bad message number");
                }
                else {
                    console.log("Responding to RETR for message " + p.messageNumber);
                    Seq()
                        .seq(function () { socket.write('+OK\r\n', this); })
                        .extend(Object.keys(m.message.headers))
                        .forEach(function (header) {
                            // TODO: Intelligent handling of duplicate headers?
                            socket.write(header + ': ' + m.message.headers[header][0] + '\r\n');
                        })
                        .seq(function () { socket.write('\r\n', this); })
                        .seq(function () { writeByteStuffed(socket, m.body, this); })
                        .seq(function () {
                            m.retreived = true;
                            IMAP_MESSAGE_IDS_TO_BE_MARKED_SEEN.push(m.message.id);
                            this();
                        })
                        .catch(callback);
                }
            } break;
            case 'DELE': {
                var m = imapMessages.messages[p.messageNumber];
                if (! m) {
                    socket.write('-ERR Bad message number\r\n');
                    callback("Bad message number");
                }
                else {
                    imapMessages.deleted[p.messageNumber] = imapMessages.messages[p.messageNumber];
                    delete imapMessages.messages[p.messageNumber];
                    Seq().seq(function () { socket.write('+OK\r\n', this); }).catch(callback);
                }
            } break;
            case 'QUIT': {
                for (k in imapMessages.deleted)
                    delete imapMessages.messages[k];
                Seq()
                    .seq(function () { socket.write('+OK\r\n', this); })
                    .seq(function () { socket.destroySoon(); })
                    .catch(callback);
            } break;
            case 'RSET': {
                for (k in imapMessages.deleted) {
                    imapMessages.messages[k] = imapMessages.deleted[k];
                    delete imapMessages.deleted[k];
                }
                Seq().seq(function () { socket.write('+OK\r\n', this); }).catch(callback);
            } break;
            case 'STAT': {
                var numMessages = Object.keys(imapMessages.messages).length;
                var octetSize = 0;
                for (k in imapMessages.messages) {
                    octetSize += new Buffer(imapMessages.messages[k].body).length;
                }
                socket.write('+OK ' + numMessages + ' ' + octetSize + '\r\n', 'utf-8', callback);
            } break;
            case 'UIDL': {
                if (typeof(p.messageNumber) != "undefined") {
                    var m = imapMessages.messages[p.messageNumber];
                    if (! m) {
                        socket.write("-ERR Bad message number\r\n");
                        callback("Bad message number");
                    }
                    socket.write('+OK ' + p.messageNumber + ' ' + m.message.id);
                }
                else {
                    Seq()
                        .seq(function () { socket.write('+OK ' + Object.keys(imapMessages.messages).length + ' messages\r\n', this); })
                        .extend(Object.keys(imapMessages.messages))
                        .forEach(function (k, i) {
                            var message = imapMessages.messages[k];
                            socket.write(message.number + ' ' + message.message.id + '\r\n', this);
                        })
                        .seq(function () { socket.write('.\r\n', this); })
                        .catch(callback);
                }
            } break;
            default: {
                closeSocketWithError(socket, "Bad command in authenticated state", callback);
            }
        }
    }
    else callback("Unknown state");
}

function startup(imapMessages, callback) {
    var server = net.createServer(function (socket) {
        socket.setEncoding('utf-8');

        socket.write("+OK POP3 server ready\r\n");

        var state = { state: 'waitinguser' }

        var currentBuffer = [];
        socket.on('data', function (s) {
            // See if it's time to poll the IMAP server again.
            if (!IMAP_IS_BEING_POLLED && new Date().getTime() - LAST_IMAP_POLL_TIME > IMAP_POLL_INTERVAL) {
                pollImap(opts/*global*/, function (e, imapMessages_) {
                    if (e) { callback(); return; }

                    for (k in imapMessages)
                        imapMessages[k] = imapMessages_[k];
                    imapMessages.messages = { }

                    // Now we have two lists of messages, the old and the new.
                    // Prune retreived messages from the old list, then
                    // append the new list and renumber.
                    //
                    // All of this is just to stop a memory leak (we don't want
                    // to keep every old message ever in memory).
                    console.log("Merging old and new...");
                    var old = imapMessages_.messages;
                    var knew = imapMessages.messages;
                    var oldks = Object.keys(old).sort();
                    var knewks = Object.keys(knew).sort();
                    var msgno = 1;
                    for (var i = 0; i < oldks.length; ++i) {
                        if (! old[oldks[i]].retreived) {
                            old[oldks[i]].message.number = msgno;
                            imapMessages.messages[msgno] = old[oldks[i]];
                            msgno++
                        }
                    }
                    for (var i = 0; i < newks.length; ++i) {
                        knew[knewks[i]].message.number = msgno;
                        imapMessages.messages[msgno] = knew[knewks[i]];
                        msgno++;
                    }
                    console.log("Now holding " + Object.keys(imapMessages.messages).length + " messages");
                });
            }

            currentBuffer.push(s);
            if (s.match(/\r\n$/)) {
                var p = parsePop(currentBuffer.join(""));
                currentBuffer = [];

                if (typeof(p) == "string") {
                    console.log("Bad command was recieved: " + p);
                    socket.write("+ERR Bad command\r\n");
                    socket.destroySoon();
                }
                else {
                    dispatch(state, imapMessages, socket, p, function (e) {
                        if (e) {
                            console.log("Connection error:");
                            console.log(e);
                            socket.destroy();
                        }
                    });
                }
            }
        });
    });

    server.listen(opts.pop_port);
    console.log("POP server started");
}

IMAP_MESSAGE_IDS_TO_BE_MARKED_SEEN = [];
function retreiveFromImap(opts, callback) {
    imap = new ImapConnection({
        username: opts.user,
        password: opts.pass,
        host: opts.imapserver,
        port: opts.port,
        secure: opts.port == 993 ? true : false
    });

    var ret;
    Seq()
        .seq(function () { imap.connect(this); })
        .seq(function () { imap.getBoxes(this); })
        .seq(function (boxes) {
            imap.openBox(opts.boxname, false/*read/write access*/, this);
        })
        .seq(function () { imap.search(['UNSEEN'], this); })
        .seq(function (xs) { console.log("Fetching " + xs.length + " messages..."); this(null, xs); })
        .flatten()
        .parMap_(function (this_, id, index) {
            console.log("Fetching message [IMAP id " + id + "]");
            this.vars.id = id;
            imap.fetch(id, { request: { headers: true, body: false, struct: false }}).on('message', function (m) {
                imap.fetch(id, { request: { headers: false, body: true, struct: false }}).on('message', function (m2) {
                    var msgText = [];
                    m2.on('data', function (chunk) {
                        msgText.push(chunk);
                    });
                    m2.on('end', function () {
                        this_(null, { number: index+1, message: m, body: msgText.join('') });
                    });
                });
            });
        })
        .unflatten()
        .seq(function (messages) {
            // Finally, mark those messages as unseen which were retreived via the POP
            // server at some earlier point.
            if (IMAP_MESSAGE_IDS_TO_BE_MARKED_SEEN.length) {
                imap.addFlags(IMAP_MESSAGE_IDS_TO_BE_MARKED_SEEN, 'Seen', function (e) {
                    IMAP_MESSAGE_IDS_TO_BE_MARKED_SEEN = [];
                    if (e) callback(e);
                    else imap.logout(function (e) { console.log("!!!"); callback(e, messages); });
                });
            }
            else imap.logout(function (e) { callback(e, messages); });
        })
        .catch(callback);
}

//
// This also writes the messages retreived to a file
// named after the POP mailbox in JSON format,
// which is useful for debugging (can start up the
// POP server quickly with cached messages).
//
IMAP_IS_BEING_POLLED = false;
LAST_IMAP_POLL_TIME = 0;
function pollImap(opts, callback) {
    var messages = { }; // Keyed by POP message number.

    IMAP_IS_BEING_POLLED = true;
    console.log("Polling the IMAP server...");
    retreiveFromImap(opts, function (e, messages_) {
        messages = { };
        for (var i = 0; i < messages_.length; ++i) {
            messages[messages_[i].number] = messages_[i];
        }

        if (e) callback(e);
        else {
            fs.open(opts.mboxname, 'w', function (e, fd) {
                if (e) callback(e);
                else {
                    var b = new Buffer(JSON.stringify(messages));
                    fs.write(fd, b, 0, b.length, null, function (e) {
                        if (e) callback(e);
                        else {
                            fs.close(fd, function () {
                                LAST_IMAP_POLL_TIME = new Date().getTime();
                                IMAP_IS_BEING_POLLED = false;
                                callback(null, { messages: messages,
                                                 deleted: { } });
                            });
                        }
                    });
                }
            });
        }
    });
}

if (require.main === module) {
    if (process.argv.length != 10) {
        console.log("Bad usage");
        process.exit(1);
    }

    opts = {
        mboxname: process.argv[2],
        popPassword: process.argv[3],
        pop_port: process.argv[4],
        imapserver: process.argv[5],
        port: process.argv[6],
        user: process.argv[7],
        pass: process.argv[8],
        boxname: process.argv[9]
    };

    function startpop(messages) {
        console.log("Starting POP server...");
        Seq().seq(function () { startup(messages, this); });
    }

    if (opts.mboxname.charAt(0) == '+') {
        opts.mboxname = opts.mboxname.substr(1);
        fs.readFile(opts.mboxname, function (e, buffer) {
            if (e) {
                console.log("Unable to read mailbox file '" + opts.mboxname + "'");
                process.exit(1);
            }
            else {
                messages = JSON.parse(buffer);
                console.log("Using stored mailbox");
                startpop({ messages: messages, deleted: { } });
            }
        });
    }
    else {
        pollImap(opts, function (e, messages) {
            if (e) {
                console.log("Error polling imap server:");
                console.log(e);
                console.log("Exiting...");
                process.exit(1);
            }
            else {
                startpop(messages);
            }
        });
    }
}