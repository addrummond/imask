A rather silly node.js script which shadows an IMAP server with a simple POP3 server.

Requires the seq and imap modules. I recommend the latest git version
of the imap module, since it has some bugfixes which are not yet in
the npm repo.

Setting up a server
===================

Imask reads options from a configuration file, by default ~/.imask. To
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
        "imapPollIntervalSeconds": 180
    }

The popUseSSL key can be set to true to have the POP server use
SSL. Currently, the connection to the IMAP server is assumed to be via
SSL if imapPort is 993, and insecure otherwise. The server prints some
simple logging information to stdout, so it should be run as follows:

    node imask.js > log

Messages which are retrieved from the POP server are marked as unseen
(i.e. unread) on the IMAP server. Applications connecting to the POP
server must use PASS authentication with the username popUsername and
the password popPassword.

Why you might want this
=======================
GMail can automatically poll a POP server for mail, but not an IMAP
server. If your mail provider only provides IMAP, imask can be used to
provide a POP server for GMail to poll.