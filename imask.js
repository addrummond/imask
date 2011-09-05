var net = require('net'),
    tls = require('tls'),
    util = require('util'),
    fs = require('fs'),
    ImapConnection = require('imap').ImapConnection,
    Seq = require('seq'),
    assert = require('assert');

function log(s) {
    console.log(new Date().toJSON() + ' ' + s);
}

function getFirstWord(s) {
    var a = s.split(/\s+/);
    return [a[0], a.slice(1).join(' ')];
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
            lastWasR = false;
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

function parsePop(s) {
    var x = getFirstWord(s);
    var firstWord = x[0];
    var remainder = x[1];

    switch (firstWord) {
        case 'USER': case 'PASS': {
            var m = /^([^\s]+)\s*$/.exec(remainder);
            if (! m)
                return "Bad '" + firstWord + "' command (" + s + ")";
            else
                return { command: firstWord, word: m[1] }
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

function Imask (opts) {
    this.opts = opts;
    if (! this.opts.log)
        this.opts.log = log;

    this.imapMessages = null; // Will be a dict { messages, deleted }, where
                              // 'messages' and 'deleted' are imap-message-id-keyed
                              // dicts.
    this.imapMessageIdsToBeMarkedSeen = [];
    this.imapIsBeingPolled = false;
    this.lastImapPollTime = 0;

    this.states = { };
//    for (k in opts.accounts) this.states[k] = { state: 'waitingforuser'; }
}

Imask.prototype._dispatchPopCommand = function (socket, socketState, p, callback) {
    var self = this, states = this.states;

    function capa() {
        socket.write('+OK Capability list follows\r\nTOP\r\nUSER\r\nEXPIRE 1\r\nUIDL\r\n.\r\n', callback);
    }

    if (! socketState.username) {
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
            else {
                var u = opts.accounts[p.word];
                if (! u) {
                    closeSocketWithError(socket, "No such mailbox", callback);
                }
                else {
                    socketState.username = p.word;
                    states[p.word] = 'waitingpass';
                    socket.write('+OK User ok\r\n', callback);
                }
            }
        }
    }
    else {
        var state = states[socketState.username];
        switch (state) {
            case: 'waitingpass': {
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
                    else if (p.word != this.opts.popPassword) {
                        closeSocketWithError(socket, "Not authenticated", callback);
                    }
                    else {
                        state.state = 'authenticated';
                        socket.write('+OK Authenticated\r\n', callback);
                        opts.log("User authenticated");
                    }
                }
            } break;
            case 'authenticated': {
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
                        else ms = Object.keys(this.imapMessages.messages);
        
                        if (ms === false) {
                            socket.write('-ERR Bad message number\r\n', callback);
                        }
                        else {
                            Seq()
                                .seq(function () { socket.write('+OK ' + Object.keys(self.imapMessages.messages).length + ' messages\r\n', this); })
                                .extend(ms)
                                .forEach(function (k, i) {
                                    var message = self.imapMessages.messages[k];
                                    socket.write(message.number + ' ' + getMessageOctetSize(message) + '\r\n', this);
                                })
                                .seq(function () { socket.write('.\r\n', callback); })
                                .catch(callback);
                        }
                    } break;
                    case 'RETR': {
                        var m = this.imapMessages.messages[p.messageNumber];
                        if (! m) {
                            socket.write('-ERR Bad message number\r\n', callback);
                        }
                        else {
                            opts.log("Responding to RETR for message " + p.messageNumber);
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
                                    m.retrieved = true;
                                    self.imapMessageIdsToBeMarkedSeen.push(m.message.id);
                                    callback();
                                })
                                .catch(callback);
                        }
                    } break;
                    case 'DELE': {
                        var m = this.imapMessages.messages[p.messageNumber];
                        if (! m) {
                            socket.write('-ERR Bad message number\r\n', callback);
                        }
                        else {
                            this.imapMessages.deleted[p.messageNumber] = this.imapMessages.messages[p.messageNumber];
                            delete this.imapMessages.messages[p.messageNumber];
                            socket.write('+OK\r\n', callback);
                        }
                    } break;
                    case 'QUIT': {
                        for (k in this.imapMessages.deleted)
                            delete this.imapMessages.messages[k];
                        Seq()
                            .seq(function () { socket.write('+OK\r\n', this); })
                            .seq(function () { socket.destroySoon(); callback(); })
                            .catch(callback);
                    } break;
                    case 'RSET': {
                        for (k in this.imapMessages.deleted) {
                            this.imapMessages.messages[k] = this.imapMessages.deleted[k];
                            delete this.imapMessages.deleted[k];
                        }
                        socket.write('+OK\r\n', callback);
                    } break;
                    case 'STAT': {
                        var numMessages = Object.keys(this.imapMessages.messages).length;
                        var octetSize = 0;
                        for (k in this.imapMessages.messages) {
                            octetSize += new Buffer(this.imapMessages.messages[k].body).length;
                        }
                        socket.write('+OK ' + numMessages + ' ' + octetSize + '\r\n', 'utf-8', callback);
                    } break;
                    case 'UIDL': {
                        if (typeof(p.messageNumber) != "undefined") {
                            var m = this.imapMessages.messages[p.messageNumber];
                            if (! m) socket.write('-ERR Bad message number\r\n', callback);
                            else socket.write('+OK ' + p.messageNumber + ' ' + m.message.id, callback);
                        }
                        else {
                            Seq()
                                .seq(function () { socket.write('+OK ' + Object.keys(self.imapMessages.messages).length + ' messages\r\n', this); })
                                .extend(Object.keys(this.imapMessages.messages))
                                .forEach(function (k, i) {
                                    var message = self.imapMessages.messages[k];
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
            } break;
            default {
                assert.ok(false, "Bad state in 'dispatch'");
            } break;
        }
}

Imask.prototype._startupPop = function (createServerFunc, callback) {
    var self = this, opts = this.opts;

    var server = createServerFunc(function (socket) {
        socket.setEncoding('utf-8');

        socket.write("+OK POP3 server ready\r\n");

        var socketState = { };
        var currentBuffer = [];
        socket.on('data', function (s) {
            currentBuffer.push(s);
            if (s.match(opts.popSuperStrict ? /\r\n$/ : /\r?\n$/)) {
                var p = parsePop(currentBuffer.join(""));
                currentBuffer = [];

                if (typeof(p) == "string") {
                    opts.log("Bad command was recieved: " + p);
                    socket.write("+ERR Bad command\r\n");
                    socket.destroySoon();
                }
                else {
                    self._dispatchPopCommand(socket, socketState, p, function (e) {
                        if (e) {
                            opts.log("Connection error:");
                            opts.log(e);
                            socket.destroy();
                        }
                    });
                }
            }
        });
    });

    server.listen(opts.popPort);
    opts.log("POP server started");
}

Imask.prototype._retrieveFromImap = function(sinceDateString, callback) {
    var self = this, opts = this.opts;

    imap = new ImapConnection({
        username: opts.imapUsername,
        password: opts.imapPassword,
        host: opts.imapHost,
        port: opts.imapPort,
        secure: opts.imapUseSSL
    });

    Seq()
        .seq(function () { imap.connect(this); })
        .seq(function () { imap.getBoxes(this); })
        .seq(function (boxes) {
            imap.openBox(opts.imapMailbox, opts.imapReadOnly, this);
        })
        .seq_(function (this_) {
            // Mark those messages as seen which were retrieved via the POP server
            // at some earlier point.
            if (!opts.imapReadOnly && self.imapMessageIdsToBeMarkedSeen.length) {
                opts.log("Marking messages as seen...");
                imap.addFlags(self.imapMessageIdsToBeMarkedSeen, 'Seen', function (e) {
                    if (e) this_(e);
                    opts.log("Marked " + self.imapMessageIdsToBeMarkedSeen.join(',') + " as seen on IMAP server");
                    self.imapMessageIdsToBeMarkedSeen = [];
                    this_();
                });
            }
            else this_();
        })
        .seq(function () { imap.search(sinceDateString ? ['UNSEEN', ['SINCE', sinceDateString]]
                                       : 'UNSEEN', this); })
        .seq(function (xs) { opts.log("Fetching " + xs.length + " messages..."); this(null, xs); })
        .flatten()
        .parMap_(function (this_, id, index) {
            opts.log("Fetching message [IMAP id " + id + "]");
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
            imap.logout(function (e) { callback(e, messages); });
        })
        .catch(callback);
}

function xDaysBefore(x, date) {
    var time = date.getTime() - x * 1000 * 60 * 60 * 24;
    var ndate = new Date(time);
    return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][ndate.getMonth()] +
           ' ' + ndate.getDate() + ', ' + ndate.getFullYear();
}

Imask.prototype._pollImap = function(opts, callback) {
    var self = this, opts = this.opts;
    var messages = { }; // Keyed by POP message number.

    this.imapIsBeingPolled = true;
    opts.log("Polling the IMAP server...");

    this._retrieveFromImap(
        xDaysBefore(opts.imapMessageAgeLimitDays, new Date()),
        function (e, messages_) {
            messages = { };
            messages_.forEach(function (m) {
                messages[m.number] = m;
            });

            if (e) callback(e);
            else {
                self.imapIsBeingPolled = false;
                callback(null, { messages: messages, deleted: { } });
            }
        }
    );
}

Imask.prototype._pollImapAgain = function (callback) {
    var self = this;

    if (this.imapIsBeingPolled) {
        opts.log("Attempt to poll while polling already underway");
        callback(); // This isn't an error condition -- we just don't want to
                    // poll again in this instance.
        return;
    }

    this._pollImap(opts/*global*/, function (e, imapMessages_) {
        if (e) { callback(e); return; }
        
        for (k in self.imapMessages)
            self.imapMessages[k] = imapMessages_[k];
        self.imapMessages.messages = { }
        
        // Now we have two lists of messages, the old and the new.
        // Prune retrieved messages from the old list, then
        // append the new list and renumber.
        //
        // All of this is just to stop a memory leak (we don't want
        // to keep every old message ever in memory).
        opts.log("Merging old and new...");
        var old = imapMessages_.messages;
        var knew = self.imapMessages.messages;
        var oldks = Object.keys(old).sort();
        var knewks = Object.keys(knew).sort();
        var msgno = 1;
        for (var i = 0; i < oldks.length; ++i) {
            if (! old[oldks[i]].retrieved) {
                old[oldks[i]].message.number = msgno;
                self.imapMessages.messages[msgno] = old[oldks[i]];
                msgno++
            }
        }
        for (var i = 0; i < knewks.length; ++i) {
            knew[knewks[i]].message.number = msgno;
            self.imapMessages.messages[msgno] = knew[knewks[i]];
            msgno++;
        }
        opts.log("Now holding " + Object.keys(self.imapMessages.messages).length + " messages");
    });
}

Imask.prototype.start = function (callback) {
    var self = this, opts = this.opts;

    opts.log("Performing initial poll of IMAP accounts...");
    Seq()
        .extend(Object.keys(opts.accounts))
        .parEach_(function (this_, username) {
            opts.log("Polling " + username + "@" + opts.accounts[username].imapHost);
            self._pollImap(opts, function (e, messages) {
                if (e) {
                    this_("Error polling " + username + "@" +
                          opts.accounts[username].imapHost + ":" + util.inspect(e));
                }
                else {
                    self.imapMessages = messages;
                }
            });
        })
        .seq_(function (this_) {
            self._startupPop(
                function (callback) {
                    if (opts.popUseSSL) {
                        return tls.createServer({
                            key: fs.readFileSync(opts.popSSLKeyFile.replace("~", home)),
                            cert: fs.readFileSync(opts.popSSLCertFile.replace("~", home)),
                            ca: opts.popSSLCaFiles ?
                                opts.popSSLCaFiles.map(function (f) {
                                    fs.readFileSync(f.replace("~", home));
                                }) : undefined
                        }, callback);
                    }
                    else return net.createServer.apply(net, arguments);
                },
                this_
            );
        })
        .extend(Object.keys(opts.accounts))
        .parEach(function (username) {
            setInterval(function () {
                self._pollImapAgain(function (e) {
                    // If there's an error repolling the imap server, log it
                    // and try again later (since the imap server has already
                    // been successfully polled once, it's most likely a
                    // temporary network issue).
                    opts.log("Error (re-)polling imap server: " + util.inspect(e));
                });
            }, opts.accounts[username].imapPollIntervalSeconds * 1000);
            this();
        })
        .catch(callback);
}

//
// When this is the main module, find a config file and start an imask server.
//
if (require.main === module) {
    if (process.argv.length > 3) {
        opts.log("Bad usage");
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

            var imask = new Imask(opts);
            imask.start(function (e) {
                if (e) {
                    log(e);
                    process.exit(1);
                }
            });
        }
    });
}