var express = require('express');

function Netlog(opts) {
    this.opts = opts;
    this.opts.maxLines = this.opts.maxLines ? this.opts.maxLines : 50;
    this.lines = new Array(this.opts.maxLines);
    this.currentLine = 0;
    this.wrapped = false;
}

Netlog.prototype.addLogLine = function (level, date, line) {
    if (this.currentLine == this.opts.maxLines) {
        this.currentLine = 0;
        this.wrapped = true;
    }

    this.lines[this.currentLine++] = { level: level, date: date.toUTCString(), line: line };
}

Netlog.prototype._linesInOrder = function () {
    var olines = new Array(this.wrapped ? this.opts.maxLines : this.currentLine);
    var count = 0;
    if (this.wrapped) {
        for (var i = this.currentLine; i < this.opts.maxLines; ++i)
            olines[count++] = this.lines[i];
    }
    for (var i = 0; i < this.currentLine; ++i)
        olines[count++] = this.lines[i];
    
    return olines;
};

Netlog.prototype.start = function (callback) {
    var self = this, opts = this.opts;

    this.app = express.createServer({
        key: opts.key,
        cert: opts.cert,
        ca: opts.ca
    });

    this.app.use(express.bodyParser());
    this.app.use(express.cookieParser());
    this.app.use(express.session({ secret: "A secret phrase" }));
    this.app.set('view engine', 'jade');
    this.app.set('views', __dirname);
    this.app.use(express.static(__dirname + '/static'));

    this.app.get('/', function (req, res) {
        if (req.session.loggedIn) res.redirect('/logs');
        else res.redirect('/login');
    });
    this.app.get('/logs', function (req, res) {
        if (! req.session.loggedIn) {
            res.redirect('/login');
        }
        else {
            res.render('logs.jade', { title: "Logs", lines: self._linesInOrder().reverse() });
        }
    });
    this.app.get('/login', function (req, res) {
        res.render('login.jade', { title: "Admin login", includes: ['login.js'] });
    });
    this.app.post('/login', function (req, res) {
        if (req.body.username == opts.username && req.body.password == opts.password) {
            req.session.loggedIn = true;
            res.redirect('/logs');
        }
        else {
            res.render('login.jade', { title: "Admin login" });
        }
    });

    this.app.listen(opts.port);
};

exports.Netlog = Netlog;