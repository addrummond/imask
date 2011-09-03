var net = require('net'),
    tls = require('tls'),
    util = require('util'),
    fs = require('fs'),
    ImapConnection = require('imap').ImapConnection,
    Seq = require('seq');

IMAP_MESSAGES = null; // Will be an imap-message-id-keyed dict.

function log(s) {
    console.log(new Date().toJSON() + ' ' + s);
}

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
        case 'APOP': case 'CAPA': case 'NOOP':
        case 'RSET': case 'QUIT': case 'STAT': {
            return { command: firstWord }; // APOP not implemented so we don't bother parsing it properly.
        } break;
        case 'LIST': case 'RETR': case 'DELE': case 'UIDL': {
            var m = remainder.match(/^(\d+)\s*$/);
            if ((firstWord == "RETR" || firstWord == "DELE") && !m)
                return firstWord + " command requires message number";
            return { command: firstWord, messageNumber: m ? m[1] : undefined };
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

function dispatch(state, socket, p, callback) {
    function capa() {
        socket.write('+OK Capability list follows\r\nTOP\r\nUSER\r\nEXPIRE 1\r\nUIDL\r\n.\r\n', callback);
    }

    if (state.state == 'waitinguser') {
        if (p.command == 'APOP') {
            socket.write('-ERR Not implemented\r\n', callback);
        }
        else if (p.command == 'CAPA') {
            capa();   
        }
        else {
            if (p.command != 'USER') {
                closeSocketWithError(socket, "Not authenticated", callback);
            }
            else if (p.word != opts.popUsername) {
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
            socket.write('-ERR Not implemented\r\n', callback);
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
                log("User authenticated");
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
                else ms = Object.keys(IMAP_MESSAGES.messages);

                if (ms === false) {
                    socket.write('-ERR Bad message number\r\n', callback);
                }
                else {
                    Seq()
                        .seq(function () { socket.write('+OK ' + Object.keys(IMAP_MESSAGES.messages).length + ' messages\r\n', this); })
                        .extend(ms)
                        .forEach(function (k, i) {
                            var message = IMAP_MESSAGES.messages[k];
                            socket.write(message.number + ' ' + getMessageOctetSize(message) + '\r\n', this);
                        })
                        .seq(function () { socket.write('.\r\n', callback); })
                        .catch(callback);
                }
            } break;
            case 'RETR': {
                // TODO: Inefficient linear search; should be in a dictionary.
                var m = IMAP_MESSAGES.messages[p.messageNumber];
                if (! m) {
                    socket.write('-ERR Bad message number\r\n', callback);
                }
                else {
                    log("Responding to RETR for message " + p.messageNumber);
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
                            callback();
                        })
                        .catch(callback);
                }
            } break;
            case 'DELE': {
                var m = IMAP_MESSAGES.messages[p.messageNumber];
                if (! m) {
                    socket.write('-ERR Bad message number\r\n', callback);
                }
                else {
                    IMAP_MESSAGES.deleted[p.messageNumber] = IMAP_MESSAGES.messages[p.messageNumber];
                    delete IMAP_MESSAGES.messages[p.messageNumber];
                    socket.write('+OK\r\n', callback);
                }
            } break;
            case 'QUIT': {
                for (k in IMAP_MESSAGES.deleted)
                    delete IMAP_MESSAGES.messages[k];
                Seq()
                    .seq(function () { socket.write('+OK\r\n', this); })
                    .seq(function () { socket.destroySoon(); callback(); })
                    .catch(callback);
            } break;
            case 'RSET': {
                for (k in IMAP_MESSAGES.deleted) {
                    IMAP_MESSAGES.messages[k] = IMAP_MESSAGES.deleted[k];
                    delete IMAP_MESSAGES.deleted[k];
                }
                socket.write('+OK\r\n', callback);
            } break;
            case 'STAT': {
                var numMessages = Object.keys(IMAP_MESSAGES.messages).length;
                var octetSize = 0;
                for (k in IMAP_MESSAGES.messages) {
                    octetSize += new Buffer(IMAP_MESSAGES.messages[k].body).length;
                }
                socket.write('+OK ' + numMessages + ' ' + octetSize + '\r\n', 'utf-8', callback);
            } break;
            case 'UIDL': {
                if (typeof(p.messageNumber) != "undefined") {
                    var m = IMAP_MESSAGES.messages[p.messageNumber];
                    if (! m) {
                        Seq().seq(function () { socket.write('-ERR Bad message number\r\n'); }).catch(callback);x
                    }
                    socket.write('+OK ' + p.messageNumber + ' ' + m.message.id, callback);
                }
                else {
                    Seq()
                        .seq(function () { socket.write('+OK ' + Object.keys(IMAP_MESSAGES.messages).length + ' messages\r\n', this); })
                        .extend(Object.keys(IMAP_MESSAGES.messages))
                        .forEach(function (k, i) {
                            var message = IMAP_MESSAGES.messages[k];
                            socket.write(message.number + ' ' + message.message.id + '\r\n', this);
                        })
                        .seq(function () { socket.write('.\r\n', callback); })
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

function startup(createServerFunc, callback) {
    var server = createServerFunc(function (socket) {
        socket.setEncoding('utf-8');

        socket.write("+OK POP3 server ready\r\n");

        var state = { state: 'waitinguser' }

        var currentBuffer = [];
        socket.on('data', function (s) {
            currentBuffer.push(s);
            if (s.match(opts.popSuperStrict ? /\r\n$/ : /\r?\n$/)) {
                var p = parsePop(currentBuffer.join(""));
                currentBuffer = [];

                if (typeof(p) == "string") {
                    log("Bad command was recieved: " + p);
                    socket.write("+ERR Bad command\r\n");
                    socket.destroySoon();
                }
                else {
                    dispatch(state, socket, p, function (e) {
                        if (e) {
                            log("Connection error:");
                            log(e);
                            socket.destroy();
                        }
                    });
                }
            }
        });
    });

    server.listen(opts.popPort);
    log("POP server started");
}

IMAP_MESSAGE_IDS_TO_BE_MARKED_SEEN = [];
function retreiveFromImap(opts, callback) {
    imap = new ImapConnection({
        username: opts.imapUsername,
        password: opts.imapPassword,
        host: opts.imapHost,
        port: opts.imapPort,
        secure: opts.port == 993 ? true : false
    });

    var ret;
    Seq()
        .seq(function () { imap.connect(this); })
        .seq(function () { imap.getBoxes(this); })
        .seq(function (boxes) {
            imap.openBox(opts.imapMailbox, false/*read/write access*/, this);
        })
        .seq(function () { imap.search(['UNSEEN'], this); })
        .seq(function (xs) { log("Fetching " + xs.length + " messages..."); this(null, xs); })
        .flatten()
        .parMap_(function (this_, id, index) {
            log("Fetching message [IMAP id " + id + "]");
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
                    log("Marked " + IMAP_MESSAGE_IDS_TO_BE_MARKED_SEEN.join(',') + " as seen on IMAP server");
                    IMAP_MESSAGE_IDS_TO_BE_MARKED_SEEN = [];
                    if (e) callback(e);
                    else imap.logout(function (e) { callback(e, messages); });
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
    log("Polling the IMAP server...");
    retreiveFromImap(opts, function (e, messages_) {
        messages = { };
        messages_.forEach(function (m) {
            messages[m.number] = m;
        });

        if (e) callback(e);
        else {
            fs.open(opts.popUsername, 'w', function (e, fd) {
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

function pollImapAgain() {
    if (IMAP_IS_BEING_POLLED) {
        log("Attempt to poll while polling already underway");
        return;
    }

    pollImap(opts/*global*/, function (e, IMAP_MESSAGES_) {
        if (e) { callback(); return; }
        
        for (k in IMAP_MESSAGES)
            IMAP_MESSAGES[k] = IMAP_MESSAGES_[k];
        IMAP_MESSAGES.messages = { }
        
        // Now we have two lists of messages, the old and the new.
        // Prune retreived messages from the old list, then
        // append the new list and renumber.
        //
        // All of this is just to stop a memory leak (we don't want
        // to keep every old message ever in memory).
        log("Merging old and new...");
        var old = IMAP_MESSAGES_.messages;
        var knew = IMAP_MESSAGES.messages;
        var oldks = Object.keys(old).sort();
        var knewks = Object.keys(knew).sort();
        var msgno = 1;
        for (var i = 0; i < oldks.length; ++i) {
            if (! old[oldks[i]].retreived) {
                old[oldks[i]].message.number = msgno;
                IMAP_MESSAGES.messages[msgno] = old[oldks[i]];
                msgno++
            }
        }
        for (var i = 0; i < knewks.length; ++i) {
            knew[knewks[i]].message.number = msgno;
            IMAP_MESSAGES.messages[msgno] = knew[knewks[i]];
            msgno++;
        }
        log("Now holding " + Object.keys(IMAP_MESSAGES.messages).length + " messages");
    });
}

if (require.main === module) {
    if (process.argv.length > 3) {
        log("Bad usage");
        process.exit(1);
    }

    var home = process.env.HOME;

    var opts;
    var config = process.argv.length == 3 ? process.argv[2] : process.env.HOME + '/.imask';
    fs.readFile(config, function (e, buffer) {
        if (e) {
            log("Unable to read configuration file " + config);
            process.exit(1);
        }
        else {
            try { opts = JSON.parse(buffer); }
            catch (err) {
                log("Error parsing configuration file " + config + " as JSON -- " + err);
                process.exit(1);
            }

            log("Imask started");

            function startpop() {
                log("Starting POP server...");
                Seq().seq(function () {
                    startup(
                        function (callback) {
                            if (opts.popUseSSL) {
                                return tls.createServer({
                                    key: fs.readFileSync(opts.popSSLKeyFile.replace("~", home)),
                                    cert: fs.readFileSync(opts.popSSLCertFile.replace("~", home)),
                                    ca: opts.popSSLCaFiles ? opts.popSSLCaFiles.map(function (f) { fs.readFileSync(f.replace("~", home)); }) : undefined
                                }, callback);
                            }
                            else return net.createServer.apply(net, arguments);
                        }
                        ,
                        this
                    );
                });

                setInterval(pollImapAgain, opts.imapPollIntervalSeconds * 1000);
            }

            if (opts.popUsername.charAt(0) == '+') {
                opts.popUsername = opts.popUsername.substr(1);
                fs.readFile(opts.popUsername, function (e, buffer) {
                    if (e) {
                        log("Unable to read mailbox file '" + opts.popUsername + "'");
                        process.exit(1);
                    }
                    else {
                        try {
                            IMAP_MESSAGES = { messages: JSON.parse(buffer), deleted: { } };
                        }
                        catch (err) {
                            log("Error parsing stored mailbox -- " + err);
                            process.exit(1);
                        }
                        log("Using stored mailbox");
                        startpop();
                    }
                });
            }
            else {
                pollImap(opts, function (e, messages) {
                    if (e) {
                        log("Error polling imap server:");
                        log(e);
                        log("Exiting...");
                        process.exit(1);
                    }
                    else {
                        IMAP_MESSAGES = messages;
                        startpop();
                    }
                });
            }
        }
    });
}