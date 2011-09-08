Node.js program that masks an IMAP server behind a simple POP3 server.

Requires the `imap` module (amongst others). I occasionally find minor
problems with the imap module which interfere with the operation of
imask. You may want to try using my fork of this module, in case there
are fixes which have not yet made it into the original
(https://github.com/addrummond/node-imap/).

Setting up a server
===================

Imask reads options from a configuration file, by default `~/.imask`. To
read from a different configuration file, pass the file name as the
sole command line argument.

The configuration file is a JSON dictionary, e.g.:

    {
        "logFile": "~/mylogfile",

        "popPort": "110",
        "popUseSSL": true,
        "popSSLKeyFile": "~/server-key.pem",
        "popSSLCertFile": "~/server-cert.pem",

        "accounts": {
            "pop_user_1_username": {
                "popPassword": "pop_user_1_password",
                "imapHost": "imap.xxx.xxx",
                "imapPort": 143,
                "imapUseSSL": false,
                "imapUsername": "my_email_username",
                "imapPassword": "my_email_password",
                "imapMailboxes": ["INBOX", "Some mailing list"],
                "imapPollIntervalSeconds": 180,
                "imapReadOnly": false,
                "imapMessageAgeLimitDays": 30
            },
            "pop_user_2_username": {
                "popPassword": "pop_user_2_password",
                "imapHost": "imap.xxx.xxx",
                "imapPort": 993,
                "imapUseSSL": true,
                "imapUsername": "my_email_username",
                "imapPassword": "my_email_password",
                "imapMailboxes": ["INBOX"],
                "imapPollIntervalSeconds": 180,
                "imapReadOnly": false,
                "imapMessageAgeLimitDays": 30
            },
        },

        "webLogsUsername": "choose_a_username",
        "webLogsPassword": "choose_a_password",
        "webLogsPort": 5000,
        "webLogsMaxLines": 50,
        "webLogsSSLKeyFile": "~/server-key.pem",
        "webLogsSSLCertFile": "~/server-cert.pem"
    }

Lines beggining with # are stripped prior to the JSON parse. The
`popUseSSL` key can be set to true to have the POP server use SSL. If
the `imapUseSSL` key is set to true, imask attempts to connect to the
IMAP server over SSL. If no log file is specified, imask logs to
stdout and stderr. Once the configuration file is set up imask can be
started as follows:

    node imask.js

Or with the configuration file explicitly specified:

    node imask.js /my/configuration/file

POP/IMAP interaction
====================
Messages which are retrieved from the POP server are marked as unseen
(i.e. unread) on the IMAP server, unless `imapReadOnly` is
true. Applications connecting to the POP server must use PASS
authentication with one of the username/password pairs specified in
the configuration file.

The `imapMessageAgeLimitDays` option can be used to stop imask
retrieving old messages from the IMAP server, even if they are
unread. This can be set to a null value if you want all messages to be
retrieved regardless of age. Note that if `imapReadOnly` is true (so
that messages retrieved via the pop server are not marked as read on
the IMAP server), then an age limit really should be set, or imask
will repeatedly download an ever-increasing set of messages.

Imask uses the IMAP id of each message to provide a unique identifier
via the UIDL extension to POP. Imask operates on the assumption that
the POP client will use UIDL to ensure that duplicate messages do not
appear in the inbox if imask is restarted. (I.e., imask does not
attempt to save any state allowing it to determine which messages were
retrieved via the pop server the last time it was run.) In the case of
GMail's POP client, this appears to work.

Imask stores everything in memory and does not write anything to
disk.

Web accessible logs
===================
If the `webLogs*` options are set, imask provides https access to
recent log entries. The number of lines stored is determined by
`webLogsMaxLines`. Lines are stored in memory, so this value should
not be enormous. To view the logs, access the http server at the
specified port, which will present a login form.

Why you might want this
=======================
GMail can automatically poll a POP server for mail, but not an IMAP
server. If your mail provider only provides IMAP, imask can be used to
provide a POP server for GMail to poll. (Although, if you have your
own server, you should also be able to use fetchmail to download mail
from the IMAP server and then pass it on to GMail's SMTP server -- I
got bored trying to make this work.)
