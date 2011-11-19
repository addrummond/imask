var net = require('net'),
    tls = require('tls'),
    util = require('util'),
    fs = require('fs'),
    ImapConnection = require('imap').ImapConnection,
    Seq = require('seq'),
    Log = require('log'),
    assert = require('assert');

// Hack to allow specifying date/time explicitly with 'log' module.
Log.prototype.log_with_date = function (date, levelStr, args) {
    var oldDate = Date;
    Date = function () { return date; };
    var r = this.log(levelStr, args);
    Date = oldDate;
    return r;
};

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
    Seq(lines)
        .forEach(function (line) {
            if (line.length && line.charAt(0) == '.') {
                socket.write('.' + line + '\n', this);
            }
            else {
                socket.write(line + '\n');
            }
        })
        .seq(function () { socket.write('\r\n.\r\n', this); })
        .seq(callback)
        .catch(callback);
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
    if (! this.opts.log) {
        // This will never get used when this script is executed,
        // but it might get used if Imask is used as a lib.
        this.opts.log = function (level, msg) {
            if (level == 'info') console.log(msg);
            else if (level == 'error') console.error(msg);
            else assert(false, "Bad log level");
        }
    }

    this.imapMessages = { };  // Will be a dict POP_username -> { messages, deleted }, where
                              // 'messages' and 'deleted' are imap-message-id-keyed
                              // dicts.

    this.imapMessageIdsToBeMarkedSeen = { }; // POP_username -> [message_id1, message_id2, ...]
    for (username in this.opts.accounts)
        this.imapMessageIdsToBeMarkedSeen[username] = [];

    this.imapIsBeingPolled = { }; // POP_username -> bool

    this.states = { }; // POP_username -> POP server states.
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
                    socket.write('+OK User ok, send password\r\n', callback);
                }
            }
        }
    }
    else {
        var username = socketState.username;
        switch (states[username]) {
            case 'waitingpass': {
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
                    else if (p.word != this.opts.accounts[username].popPassword) {
                        closeSocketWithError(socket, "Not authenticated", callback);
                    }
                    else {
                        states[username] = 'authenticated';
                        socket.write('+OK Authenticated\r\n', callback);
                        opts.log('info', "User " + username + " authenticated");
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
                        else ms = Object.keys(this.imapMessages[username].messages);
        
                        if (ms === false) {
                            socket.write('-ERR Bad message number\r\n', callback);
                        }
                        else {
                            Seq()
                                .seq(function () {
                                    socket.write('+OK ' +
                                                 Object.keys(self.imapMessages[username].messages).length +
                                                 ' messages\r\n'
                                                 ,
                                                 this);
                                })
                                .extend(ms)
                                .forEach(function (k, i) {
                                    var message = self.imapMessages[username].messages[k];
                                    socket.write(message.number + ' ' + getMessageOctetSize(message) + '\r\n', this);
                                })
                                .seq(function () { socket.write('.\r\n', callback); })
                                .catch(callback);
                        }
                    } break;
                    case 'RETR': {
                        var m = this.imapMessages[username].messages[p.messageNumber];
                        if (! m) {
                            socket.write('-ERR Bad message number\r\n', callback);
                        }
                        else {
                            opts.log('info', "Responding to RETR for message " + p.messageNumber + " of " + username);
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
                                    self.imapMessageIdsToBeMarkedSeen[username].push([m.mailbox, m.message.id]);
                                    callback();
                                })
                                .catch(callback);
                        }
                    } break;
                    case 'DELE': {
                        var m = this.imapMessages[username].messages[p.messageNumber];
                        if (! m) {
                            socket.write('-ERR Bad message number\r\n', callback);
                        }
                        else {
                            this.imapMessages[username].deleted[p.messageNumber] =
                                this.imapMessages[username].messages[p.messageNumber];
                            delete this.imapMessages[username].messages[p.messageNumber];
                            socket.write('+OK\r\n', callback);
                        }
                    } break;
                    case 'QUIT': {
                        for (k in this.imapMessages[username].deleted)
                            delete this.imapMessages[username].messages[k];
                        Seq()
                            .seq(function () { socket.write('+OK\r\n', this); })
                            .seq(function () { socket.destroySoon(); callback(); })
                            .catch(callback);
                    } break;
                    case 'RSET': {
                        for (k in this.imapMessages[username].deleted) {
                            this.imapMessages[username].messages[k] = this.imapMessages[username].deleted[k];
                            delete this.imapMessages[username].deleted[k];
                        }
                        socket.write('+OK\r\n', callback);
                    } break;
                    case 'STAT': {
                        var numMessages = Object.keys(this.imapMessages[username].messages).length;
                        var octetSize = 0;
                        for (k in this.imapMessages[username].messages) {
                            octetSize += new Buffer(this.imapMessages[username].messages[k].body).length;
                        }
                        socket.write('+OK ' + numMessages + ' ' + octetSize + '\r\n', 'utf-8', callback);
                    } break;
                    case 'UIDL': {
                        if (typeof(p.messageNumber) != "undefined") {
                            var m = this.imapMessages[username].messages[p.messageNumber];
                            if (! m) socket.write('-ERR Bad message number\r\n', callback);
                            else socket.write('+OK ' + p.messageNumber + ' ' + m.message.id + "\r\n", callback);
                        }
                        else {
                            Seq()
                                .seq(function () {
                                    socket.write('+OK ' +
                                                 Object.keys(self.imapMessages[username].messages).length +
                                                 ' messages\r\n'
                                                 ,
                                                 this);
                                })
                                .extend(Object.keys(this.imapMessages[username].messages))
                                .forEach(function (k, i) {
                                    var message = self.imapMessages[username].messages[k];
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
            default: {
                assert.ok(false, "Bad state in 'dispatch'");
            } break;
        }
    }
}

Imask.prototype._startPop = function (createServerFunc, callback) {
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
                    // This is an error from the client's perspective, but not from ours.
                    opts.log('info', "Bad command was recieved: " + p);
                    socket.write("+ERR Bad command\r\n");
                    socket.destroySoon();
                }
                else {
                    self._dispatchPopCommand(socket, socketState, p, function (e) {
                        if (e) {
                            opts.log('error', "Connection error:");
                            opts.log(e);
                            socket.destroy();
                        }
                    });
                }
            }
        });
    });

    server.listen(opts.popPort, function (e) {
        if (! e)
            opts.log('info', "POP server started");
        callback(e);
    });
}

function imapservername(opts, username) { // Used in logging.
    return '"' + opts.accounts[username].imapUsername + '"@' + opts.accounts[username].imapHost;
}

function mailboxlist(boxes, prefix, list) {
    if (! prefix) prefix = [];
    if (! list) list = [];

    for (k in boxes) {
        list.push(prefix.join('') + k);
        if (boxes[k] && boxes[k].children !== null)
            mailboxlist(boxes[k].children, prefix.concat([k + (boxes[k].delim ? boxes[k].delim : '/')]), list);
    }

    return list.map(function (x) { return '"' + x + '"'; }).join(', ');
}

Imask.prototype._retrieveFromImap = function(username, sinceDateString, callback) {
    var self = this, opts = this.opts;

    var imap = new ImapConnection({
        username: opts.accounts[username].imapUsername,
        password: opts.accounts[username].imapPassword,
        host: opts.accounts[username].imapHost,
        port: opts.accounts[username].imapPort,
        secure: opts.accounts[username].imapUseSSL
    });
    imap.on('error', callback);

    var total = 0;
    Seq()
        .seq(function () { imap.connect(this); })
        .seq_(function (this_) {
            // Mark those messages as seen which were retrieved via the POP server
            // at some earlier point.
            if (!opts.accounts[username].imapReadOnly && self.imapMessageIdsToBeMarkedSeen[username].length) {
                opts.log('info', "Marking messages as seen for " + imapservername(opts, username));
                // Sort and group by mailbox.
                var sorted = self.imapMessageIdsToBeMarkedSeen[username].slice(0)
                            .sort(function (x, y) { return x[0].localeCompare(y[0]); });
                var grouped = [];
                var current = [];
                var lastmailbox = self.imapMessageIdsToBeMarkedSeen[username][0][0];
                for (var i = 0; i < sorted.length; ++i) {
                    if (sorted[i][0] == lastmailbox)
                        current.push(sorted[i][1]);
                    else {
                        grouped.push({ ids: current, mailbox: lastmailbox });
                        current = [sorted[i][1]];
                    }
                }
                grouped.push({ ids: current, mailbox: lastmailbox });

                Seq(grouped)
                    .forEach_(function (this__, tobemarked) {
                        var mailbox = tobemarked.mailbox, ids = tobemarked.ids;
                        imap.openBox(mailbox, false, function (e) {
                            if (e) this__(e);
                            else {
                                imap.addFlags(ids, 'Seen', function (e) {
                                    if (e) this__(e);
                                    else {
                                        opts.log('info', "Marked " + ids.join(',') + " as seen on " +
                                                 imapservername(opts, username));
                                        this__();
                                    }
                                });
                            }
                        });
                    })
                    .seq(function () {
                        self.imapMessageIdsToBeMarkedSeen[username] = [];
                        this_()
                    })
                    .catch(this_);
            }
            else this_();
        })
        .extend(opts.accounts[username].imapMailboxes)
        .seqMap_(function (this_, box) {
            imap.openBox(box, opts.accounts[username].imapReadOnly, function (e) {
                if (e) this_(e);
                else imap.search(sinceDateString ? ['UNSEEN', ['SINCE', sinceDateString]] : ['UNSEEN'], this_);
            });
        })
        .unflatten()
        .seq(function (resultsLists) {
            resultsLists.forEach(function (x) { total += x.length; });

            opts.log('info', "Fetching " + total + " messages for " + imapservername(opts, username) + "...");
            if (total == 0) { // Shortcut to make this common case more efficient.
                this('nothingtodo');
                return;
            }

            var rsWithBaseId = [];
            var lastBase = 0;
            resultsLists.forEach(function (resultList) {
                rsWithBaseId.push([resultList, lastBase]);
                lastBase += resultList.length;
            });
            assert.ok(rsWithBaseId.length == opts.accounts[username].imapMailboxes.length,
                      "Mismatched lengths");
            this.vars.currentMailboxIndex = 0;
            this(null, rsWithBaseId);
        })
        .flatten(false)
        .seqMap_(function (this_, resultListPr) {
            var resultList = resultListPr[0];
            var base = resultListPr[1];

            if (resultList.length == 0) {
                this_(null, []);
                return;
            }

            var currentMailboxIndex = this.vars.currentMailboxIndex++;
            imap.openBox(
                opts.accounts[username].imapMailboxes[currentMailboxIndex],
                opts.accounts[username].imapReadOnly,
                function (e) {
                    if (e) this_(e);
                    else {
                        var results = { }; // Keyed by IMAP id.
                        var count = 0;
                        var currentMsgNum = 1;
                        // Get headers.
                        imap.fetch(resultList, { request: { headers: true, body: false, struct: false }})
                        .on('message', function (m) {
                            ++count;
                            m.on('end', function () {
                                if (typeof(results[m.id]) == "undefined") results[m.id] = { };
                                results[m.id].message = m;
                                results[m.id].mailbox =
                                    opts.accounts[username].imapMailboxes[currentMailboxIndex];
                            })
                            .on('error', this_);
                        }).on('error', function (e) { this_(e); });
                        // Get bodies.
                        imap.fetch(resultList, { request: { headers: false, body: true, struct: false }})
                        .on('message', function (m) {
                            var msgText = [];
                            m.on('data', function (chunk) { msgText.push(chunk); })
                            .on('end', function () {
                                if (typeof(results[m.id]) == "undefined") results[m.id] = { };
                                results[m.id].number = base + currentMsgNum++;
                                results[m.id].body = msgText.join('');
                                opts.log('info', "Fetched message IMAP=" + m.id + //" POP=" + (results[m.id].number || "?") +
                                                 " for " + imapservername(opts, username));
                                ++count;
                                if (count == resultList.length * 2) {
                                    this_(null, Object.keys(results).map(function (k) { return results[k]; }));
                                }
                            })
                            .on('error', this_);
                        }).on('error', this_);
                    }
            });
        })
        .unflatten()
        .seq(function (listOfMessageLists) {
            imap.logout(function (e) {
                // As far as I know, there's no good way of flattening an array in JS
                // (could apply concat, but not robust for big arrays).
                var flatl = new Array(total);
                var i = 0;
                for (var j = 0; j < listOfMessageLists.length; ++j) {
                    for (var k = 0; k < listOfMessageLists[j].length; ++k) {
                        flatl[i++] = listOfMessageLists[j][k];
                    }
                }
                callback(e, flatl)
            });
        })
        .catch(function (e) {
            imap.logout(function (e2) {
                if (e == 'nothingtodo') {
                    callback(e2, []);
                }
                else {
                    // If there was an error logging out, this is probably a result
                    // of the previous error (e), so we report e rather than e2.
                    callback(e);
                }
            });
        });
}

function xDaysBefore(x, date) {
    var time = date.getTime() - x * 1000 * 60 * 60 * 24;
    var ndate = new Date(time);
    return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][ndate.getMonth()] +
           ' ' + ndate.getDate() + ', ' + ndate.getFullYear();
}

Imask.prototype._pollImap = function(username, callback) {
    var self = this, opts = this.opts;
    var messages = { }; // Keyed by POP message number.

    this.imapIsBeingPolled[username] = true;
    opts.log('info', "Polling the IMAP server for " + imapservername(opts, username) + " ...");

    this._retrieveFromImap(
        username,
        opts.accounts[username].imapMessageAgeLimitDays
            ? xDaysBefore(opts.accounts[username].imapMessageAgeLimitDays, new Date())
            : null
        ,
        function (e, messages_) {
            self.imapIsBeingPolled[username] = false;
            if (e) {
                callback(e)
            }
            else {
                messages = { };
                messages_.forEach(function (m) {
                    messages[m.number] = m;
                });

                if (e)
                    callback(e);
                else
                    callback(null, { messages: messages, deleted: { } });
            }
        }
    );
}

Imask.prototype._pollImapAgain = function (username, callback) {
    var self = this, opts = this.opts;

    if (this.imapIsBeingPolled[username]) {
        opts.log('info', "Attempt to poll IMAP server for " +
                 imapservername(opts, username) +
                 " while polling already underway");
        callback(); // This isn't an error condition -- we just don't want to
                    // poll again in this instance.
        return;
    }

    this._pollImap(username, function (e, imapMessages_) {
        if (e) { callback(e); return; }
        
        for (k in self.imapMessages[username])
            self.imapMessages[username][k] = imapMessages_[k];
        self.imapMessages[username].messages = { }
        
        // Now we have two lists of messages, the old and the new.
        // Prune retrieved messages from the old list, then
        // append the new list and renumber.
        //
        // All of this is just to stop a memory leak (we don't want
        // to keep every old message ever in memory).
        opts.log('info', "Merging old and new for " + imapservername(opts, username) + " ...");
        var old = imapMessages_.messages;
        var knew = self.imapMessages[username].messages;
        var oldks = Object.keys(old).sort();
        var knewks = Object.keys(knew).sort();
        var msgno = 1;
        for (var i = 0; i < oldks.length; ++i) {
            if (! old[oldks[i]].retrieved) {
                old[oldks[i]].number = msgno;
                self.imapMessages[username].messages[msgno] = old[oldks[i]];
                msgno++
            }
        }
        for (var i = 0; i < knewks.length; ++i) {
            knew[knewks[i]].number = msgno;
            self.imapMessages[username].messages[msgno] = knew[knewks[i]];
            msgno++;
        }
        
        opts.log('info',
                 "Now holding " + msgno + " messages for " +
                 imapservername(opts, username))

        for (var i = 0; i < self.imapMessages[username].messages.length; ++i) {
            opts.log('info', "XX: " + self.imapMessages[username].messages[i].number + " : " + self.imapMessages[username].messages[i].message.date);
        }

        callback();
    });
}

Imask.prototype.start = function (callback) {
    var self = this, opts = this.opts;

    opts.log('info', "Performing initial poll of IMAP accounts...");
    Seq(Object.keys(opts.accounts))
        .parEach_(function (this_, username) {
            self._pollImap(username, function (e, messagesAndDeleted) {
                if (e) {
                    this_("Error polling IMAP server for " + imapservername(opts,username) + ':' + util.inspect(e));
                }
                else {
                    opts.log('info', "Finished polling IMAP server for " + imapservername(opts,username));
                    opts.log('info',
                             "Now holding " + Object.keys(messagesAndDeleted.messages).length + " messages for " +
                             imapservername(opts, username));
                    self.imapMessages[username] = messagesAndDeleted;
                    this_();
                }
            });
        })
        .seq_(function (this_) {
            self._startPop(
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
        .forEach(function (username) {
            var interval = opts.accounts[username].imapPollIntervalSeconds;
            if (interval) interval *= 1000; else interval = 15 * 60 * 1000;
            setInterval(function () {
                self._pollImapAgain(username, function (e) {
                    // If there's an error repolling the imap server, log it
                    // and try again later (since the imap server has already
                    // been successfully polled once, it's most likely a
                    // temporary network issue).
                    if (e)
                        opts.log('error',
                                 "Error (re-)polling IMAP server for" +
                                 imapservername(opts, username) + ':' + util.inspect(e));
                });
            },  interval);
            this();
        })
        .catch(callback);
}

//
// When this is the main module, find a config file and start an imask server.
//
if (require.main === module) {
    if (process.argv.length > 3) {
        console.error("Bad usage");
        process.exit(1);
    }

    var home = process.env.HOME;

    var opts;
    var config = process.argv.length == 3 ? process.argv[2] : process.env.HOME + '/.imask';
    fs.readFile(config, function (e, buffer) {
        if (e) {
            console.error("Unable to read configuration file " + config);
            process.exit(1);
        }
        else {
            // Strip '#' comments.
            var lines = buffer.toString('utf-8').split('\n');
            var newlines = [];
            lines.forEach(function (l) {
                if (! l.match(/^\s*#.*$/))
                    newlines.push(l);
            });
            var configstring = newlines.join('\n');
            try { opts = JSON.parse(configstring); }
            catch (err) {
                console.error("Error parsing configuration file " + config + " as JSON -- " + err);
                process.exit(1);
            }

            // Check that there aren't two POP accounts masking the same IMAP account.
            var seen = { };
            for (popUsername in opts.accounts) {
                if (seen[opts.accounts[popUsername].imapUsername + '@' + opts.accounts[popUsername].imapHost]) {
                    console.error("Bad config: you can't mask the same IMAP account with multiple POP accounts.");
                    process.exit(1);
                }
                seen[opts.accounts[popUsername].imapUsername + '@' + opts.accounts[popUsername].imapHost] = true;
            }

            // Start the web-accessible logging server if specified.
            var netlog = null;
            var webLogsDefaultPort = 3000;
            if (opts.webLogsUsername) {
                var Netlog = require('./netlog').Netlog;
                netlog = new Netlog({
                    port: opts.webLogsPort || webLogsDefaultPort,
                    key: fs.readFileSync(opts.webLogsSSLKeyFile.replace("~", home)),
                    cert: fs.readFileSync(opts.webLogsSSLCertFile.replace("~", home)),
                    ca: opts.webLogsSSLCaFiles ?
                        opts.webLogsSSLCaFiles.map(function (f) {
                            fs.readFileSync(f.replace("~", home));
                        }) : undefined,
                    username: opts.webLogsUsername,
                    password: opts.webLogsPassword,
                    maxLines: opts.webLogsMaxLines || 50
                });
                
                netlog.start();
            }

            var mylog = new Log(Log.INFO,
                                opts.logFile
                                    ? fs.createWriteStream(opts.logFile.replace("~", home), { flags: 'a' })
                                    : undefined);
            opts.log = function (level, msg) {
                var d = new Date();
                if (level == 'error') {
                    mylog.log_with_date(d, 'ERROR', [msg]);
                    if (netlog) netlog.addLogLine('error', d, msg);
                }
                else if (level == 'info') {
                    mylog.log_with_date(d, 'INFO', [msg]);
                    if (netlog) netlog.addLogLine('info', d, msg);
                }
                else assert.ok(false, "Bad log level");
            }

            if (netlog) opts.log('info', 'Started web logging server on ' + (opts.webLogsPort || webLogsDefaultPort));

            var imask = new Imask(opts);

            process.on("uncaughtException", function (e) {
                e.ignore = true;
                opts.log('error', "Uncaught exception (ignoring): " + util.inspect(e.stack, true, 5) + " -- " +
                                  "this should not happen, server may now be in an undefined state and " +
                                  "should be restarted.");
                imask.imapIsBeingPolled = false; // Bit of a hack.
            });

            opts.log('info', "Imask started");

            imask.start(function (e) {
                if (e) {
                    opts.log('error', util.inspect(e));
                    process.exit(1);
                }
            });
        }
    });
}

exports.Imask = Imask
