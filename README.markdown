A rather silly node.js script which shadows an IMAP server with a simple POP3 server.

Requires the `seq` and `imap` modules. I recommend the latest git version
of the `imap` module, since it has some bugfixes which are not yet in
the npm repo.

Setting up a server
===================

Imask reads options from a configuration file, by default `~/.imask`. To
read from a different configuration file, pass the file name as the
sole command line argument.

The configuration file is a JSON dictionary, e.g.:

    {
        "popUsername": "choose_a_username",
        "popPassword": "choose_a_password",
        "popPort": "110",
        "popUseSSL": true,
        "popSSLKeyFile": "~/server-key.pem",
        "popSSLCertFile": "~/server-cert.pem",
        "imapHost": "imap.xxx.xxx",
        "imapPort": 143,
        "imapUsername": "my_email_username",
        "imapPassword": "my_email_password",
        "imapMailbox": "INBOX",
        "imapPollIntervalSeconds": 180,
        "imapReadOnly": false,
        "imapMessageAgeLimitDays": 30
    }

The `popUseSSL` key can be set to true to have the POP server use
SSL. Currently, the connection to the IMAP server is assumed to be via
SSL if `imapPort` is 993, and insecure otherwise. The server prints some
simple logging information to stdout, so it should be run as follows:

    node imask.js > log

Messages which are retrieved from the POP server are marked as unseen
(i.e. unread) on the IMAP server, unless `imapReadOnly` is
true. Applications connecting to the POP server must use PASS
authentication with the username `popUsername` and the password
`popPassword`.

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

Why you might want this
=======================
GMail can automatically poll a POP server for mail, but not an IMAP
server. If your mail provider only provides IMAP, imask can be used to
provide a POP server for GMail to poll. (Although, if you have your
own server, you should also be able to use fetchmail to download mail
from the IMAP server and then pass it on to GMail's SMTP server -- I
got bored trying to make this work.)