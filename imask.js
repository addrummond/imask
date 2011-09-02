var net = require('net'),
    sys = require('sys'),
    util = require('util'),
    fs = require('fs'),
    ImapConnection = require('imap').ImapConnection,
    Seq = require('seq');

var IMAP_POLL_INTERVAL = 15 * 60 * 60 * 1000; // Milliseconds.

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
        case 'APOP': case 'CAPA': {
            return { command: firstWord }; // APOP not implemented so we don't bother parsing it properly.
        } break;
        case 'LIST': case 'RETR': case 'DELE': {
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
            socket.write('+OK Capability list follows\r\nTOP\r\nUSER\r\n.\r\n', this);
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
            }
        }
    }
    else if (state.state == 'authenticated') {
        switch (p.command) {
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
                        .seq(function () { socket.write('+OK ' + imapMessages.messages.length + ' messages\r\n', this); })
                        .extend(ms)
                        .forEach(function (k) {
                            var message = imapMessages.messages[k];
                            socket.write(message.message.id + ' ' + getMessageOctetSize(message) + '\r\n', this);
                        });
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
                    Seq()
                        .seq(function () { socket.write('+OK\r\n', this); })
                        .extend(Object.keys(m.message.headers))
                        .forEach(function (header) {
                            // TODO: Intelligent handling of duplicate headers?
                            socket.write(header + ': ' + m.message.headers[header][0] + '\r\n');
                        })
                        .seq(function () { socket.write('\r\n', this); })
                        .seq(function () { writeByteStuffed(socket, m.body,  this); })
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
                var numMessages = imapMessages.messages.length;
                var octetSize = 0;
                for (k in imapMessages.messages) {
                    octetSize += new Buffer(imapMessages.messages[k].body).length;
                }
                socket.write('+OK ' + numMessages + ' ' + octetSize + '\r\n', 'utf-8', callback);
            } break;
            default: {
                closeSocketWithError(socket, "Bad command in authenticated state", callback);
            }
        }
    }
    else callback("Unknown state");
}

function startup(imapMessages, lastImapPollTime, callback) {
    var server = net.createServer(function (socket) {
        socket.setEncoding('utf-8');

        socket.write("+OK POP3 server ready\r\n");

        var state = { state: 'waitinguser' }

        var currentBuffer = [];
        socket.on('data', function (s) {
            // See if it's time to poll the IMAP server again.
            if (new Date().getTime() - lastImapPollTime > IMAP_POLL_INTERVAL) {
                pollImap(opts/*global*/, function (imapMessages_) {
                    for (k in imapMessages)
                        imapMessages[k] = imapMessages_[k];
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
            imap.openBox(opts.boxname, true/*readonly*/, this);
        })
        .seq(function () { imap.search(['UNSEEN'], this); })
        .seq(function (xs) { console.log("Fetching " + xs.length + " messages..."); this(null, xs); })
        .flatten()
        .parMap_(function (this_, id) {
            console.log("Fetching message " + id);
            this.vars.id = id;
            imap.fetch(id, { request: { headers: true, body: false, struct: false }}).on('message', function (m) {
                imap.fetch(id, { request: { headers: false, body: true, struct: false }}).on('message', function (m2) {
                    var msgText = [];
                    m2.on('data', function (chunk) {
                        msgText.push(chunk);
                    });
                    m2.on('end', function () {
                        this_(null, { message: m, body: msgText.join('') });
                    });
                });
            });
        })
        .unflatten()
        .seq(function (messages) { imap.logout(); callback(null, messages); })
        .catch(callback);
}

//
// This also writes the messages retreived to a file
// named after the POP mailbox in JSON format,
// which is useful for debugging (can start up the
// POP server quickly with cached messages).
//
function pollImap(opts, callback) {
    var messages = { }; // Keyed by IMAP messaged id.

    retreiveFromImap(opts, function (e, messages_) {
        messages = { };
        for (var i = 0; i < messages_.length; ++i) {
            messages[messages_[i].message.id] = messages_[i];
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
                            fs.close(fd);
                            callback(null, { messages: messages,
                                             deleted: { } });
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
        Seq().seq(function () { startup(messages, new Date().getTime(), this); });
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
        console.log("Performing initial poll of IMAP server...");
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