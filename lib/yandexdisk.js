var DomJS = Npm.require('dom-js');
var https = Npm.require('https');
var xml2js = Npm.require('xml2js');

var separateReqPool = {maxSockets: 100};
/**
 * @type {YandexDisk}
 *
 * @property {number} timeout
 */
YandexDisk = class YandexDisk{
    constructor(login, password){
        this.login = login;
        if (arguments.length < 2) {
            this._auth = 'OAuth ' + login;
        } else {
            this._auth = 'Basic ' + Buffer.from(login + ':' + password, 'utf8').toString('base64');
        }
        this._workDir = '/';
        this.timeout = 60000;
    }

    get isMintaStorage(){
        return this.login.toLowerCase().indexOf('@storage.minta365.ru')>-1 || this.login.toLowerCase().indexOf('@webdav.minta365.ru')>-1;
    }

    cd(path) {
        this._workDir = this._normalizePath(path);
    }

    writeFile(path, content, encoding, callback) {
        var body = new Buffer(content, encoding);
        var headers = {
            'Expect': '100-continue',
            'Content-Type': 'application/binary',
            'Content-Length': body.length
        };
        this._request('PUT', path, headers, body, null, function(err) {
            return callback(err);
        });
    }

    uploadFile(srcFile, targetPath, callback) {
        var that = this;
        require('fs').stat(srcFile, function(err, stats) {
            if (err) {
                return callback(err);
            }
            if (!stats.isFile()) {
                return callback(new Error('Not found.'));
            }
            var headers = {
                'Expect': '100-continue',
                'Content-Type': 'application/binary',
                'Content-Length': stats.size
            };
            that._request('PUT', targetPath, headers, require('fs').createReadStream(srcFile), null, function(err) {
                return callback(err);
            });
        });
    }

    uploadDir(srcDir, targetDir, callback) {
        var that = this;
        this.mkdir(targetDir, function(err) {
            if (err) {
                return callback(err);
            }
            require('fs').readdir(srcDir, function(err, files) {
                if (err) {
                    return callback(err);
                }
                (function next(i) {
                    if (i < files.length) {
                        var srcFullname = require('path').join(srcDir, files[i]);
                        var targetFullname = targetDir + '/' + files[i];
                        require('fs').stat(srcFullname, function(err, stats) {
                            if (err) {
                                return callback(err);
                            }
                            var uploadFn = stats.isDirectory() ? that.uploadDir : stats.isFile() ? that.uploadFile : null;
                            if (uploadFn) {
                                uploadFn.call(that, srcFullname, targetFullname, function(err) {
                                    if (err) {
                                        return callback(err);
                                    }
                                    next(i + 1);
                                });
                            } else {
                                next(i + 1);
                            }
                        })
                    } else {
                        callback(null);
                    }
                })(0);
            });
        });
    }

    readFile(path, encoding, callback) {
        var headers = {
            'TE': 'chunked',
            'Accept-Encoding': 'gzip'
        };
        this._request('GET', path, headers, null, encoding, callback);
    }

    downloadFile(srcPath, targetFile, callback) {
        var headers = {
            'TE': 'chunked',
            'Accept-Encoding': 'gzip'
        };
        this._request('GET', srcPath, headers, null, require('fs').createWriteStream(targetFile), callback);
    }

    remove(path, callback) {
        this._request('DELETE', path, null, null, null, function(err) {
            if(callback)
                callback(err);
        });
    }

    exists(path, callback) {
        this._request('PROPFIND', path, {Depth: 0}, null, null, function(err) {
            if (err) {
                if (err.message == 'Not found') {
                    return callback(null, false);
                }
                return callback(err);
            }
            return callback(null, true);
        });
    }

    ensureDir(path){
        var client = this;
        return new MalibunPromise((resolve,reject)=>{
            meteorAsync.seqNew([
                function exists(h,cb){
                    client.exists(path,(err,exists)=>{
                        cb(null,exists);
                    });
                },
                function create(h,cb){
                    if(h.exists)
                        return cb();
                    var dirs = path.split('/');
                    var pathches = dirs.map((item,index)=>{
                        if(index==0)
                            return item;
                        return dirs.slice(0,index+1).join('/')
                    });
                    meteorAsync.waterfall(
                        pathches.map((dirPath)=>{
                            return function(cb){
                                client.mkdir(dirPath,function(){cb();})
                            }
                        })
                    ).finally(()=>{
                        cb();
                    });
                }
            ]).finally(()=>{
                resolve(true);
            });
        });
    }

    mkdir(dirname, callback) {
        this._request('MKCOL', dirname, null, null, null, function(err, response) {
            if (err) {
                return callback(err);
            }
            return callback(null, response != 'mkdir: resource already exists');
        });
    }

    readdir(path, callback) {
        this._request('PROPFIND', path, {Depth: 1}, null, 'utf8', function(err, response) {
            if (err) {
                return callback(err);
            }
            try {
                new DomJS.DomJS().parse(response, function(err, root) {
                    if (!err) {
                        try {
                            var dir = [];
                            root.children.forEach(function(node) {
                                if (node.name == 'd:response') {
                                    dir.push({
                                        href: getNodeValue(node, 'd:href'),
                                        displayName: getNodeValue(node, 'd:displayname'),
                                        creationDate: getNodeValue(node, 'd:creationdate'),
                                        isDir: !!getNodes(node, 'd:collection').length,
                                        size: getNodeValue(node, 'd:getcontentlength'),
                                        lastModified: getNodeValue(node, 'd:getlastmodified')
                                    });
                                }
                            }, this);
                            // Первым всегда идёт сама директория, она нам в этом месте не нужна
                            dir.shift();
                            return callback(null, dir);
                        } catch (e) {
                            return callback(e);
                        }
                    }
                });
            } catch (e) {
                return callback(e);
            }
        });
    }

    stat(path){
        path = path || this._workDir;
        return new MalibunPromise((resolve,reject,promise)=>{
            var body = `<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:quota-available-bytes/>
    <D:quota-used-bytes/>
  </D:prop>
</D:propfind>`;
            this._request('PROPFIND', path, {Depth: 1}, body, 'utf8', function(err, response) {
                if (err)
                    return reject(err);
                try {
                    xml2js.parseString(response, function (err, result) {
                        if(err)
                            return reject(err);
                        var available = Number( safeGet(result,'d:multistatus.d:response.0.d:propstat.0.d:prop.0.d:quota-available-bytes.0',0) );
                        if(!available){
                            available = Number( safeGet(result,'D:multistatus.D:response.0.D:propstat.0.D:prop.0.a:quota-available-bytes.0._',0) );
                        }
                        var used = Number( safeGet(result,'d:multistatus.d:response.0.d:propstat.0.d:prop.0.d:quota-used-bytes.0',0) );
                        if(!used){
                            used = Number( safeGet(result,'D:multistatus.D:response.0.D:propstat.0.D:prop.0.a:quota-used-bytes.0._',0) );
                        }
                        if(used||available)
                            return resolve({available:available,used:used});
                        return reject(new Error('Неизвестный ответ'), result);
                    });
                } catch (e) {
                    return reject(e);
                }
            });
        });
    }

    isPublic(path, callback) {
        var body = '<propfind xmlns="DAV:">' +
            '<prop>' +
            '<public_url xmlns="urn:yandex:disk:meta"/>' +
            '</prop>' +
            '</propfind>' ;
        var getPublicUrl = this._getPublicUrl;
        this._request('PROPFIND', path, {Depth: 0}, body , null, function(err, response) {
            return getPublicUrl(err, response, callback);
        });
    }

    publish(path, callback) {
        var body = '<propertyupdate xmlns="DAV:">' +
            '<set>' +
            '<prop>' +
            '<public_url xmlns="urn:yandex:disk:meta">true</public_url>' +
            '</prop>' +
            '</set>' +
            '</propertyupdate>' ;
        var getPublicUrl = this._getPublicUrl;
        this._request('PROPPATCH', path, null, body , null, function(err, response) {
            return getPublicUrl(err, response, callback);
        });
    }

    unPublish(path, callback) {
        var body = '<propertyupdate xmlns="DAV:">' +
            '<remove>' +
            '<prop>' +
            '<public_url xmlns="urn:yandex:disk:meta" />' +
            '</prop>' +
            '</remove>' +
            '</propertyupdate>' ;
        var getPublicUrl = this._getPublicUrl;
        this._request('PROPPATCH', path, null, body , null, function(err, response) {
            return getPublicUrl(err, response, callback);
        });
    }

    copy(path, destination, callback) {
        var headers = {'Destination': encodeURI(this._normalizePath(destination))};
        this._request('COPY', path, headers, null, null, function(err) {
            if (err) {
                return callback(err);
            }
            return callback(null, true);
        });
    }

    move(path, destination, callback) {
        var headers = {'Destination': encodeURI(this._normalizePath(destination))};
        this._request('MOVE', path, headers, null, null, function(err) {
            if (err) {
                return callback(err);
            }
            return callback(null, true);
        });
    }

    _normalizePath(path) {
        return path.indexOf('/') == 0 ? path : require('path').join(this._workDir, path).replace(/\\/g, '/');
    }

    _request(method, path, headers, body, responseType, callback) {
        callback = _.once(callback);
        var options = {
            pool: separateReqPool,
            host: this.isMintaStorage ?'webdavstorage.minta365.ru':'webdav.yandex.ru',
            port: 443,
            method: method.toUpperCase(),
            path: encodeURI(this._normalizePath(path)),
            headers: {
                'Host': this.isMintaStorage ?'webdavstorage.minta365.ru':'webdav.yandex.ru',
                'Accept': '*/*',
                'Authorization': this._auth
            }
        };
        Object.keys(headers || {}).forEach(function(header) {
            options.headers[header] = headers[header];
        });
        var that=this;

        var req = https.request(options, function(res) {
            var code = res.statusCode;
            if (code == 401) {
                return callback(new Error('Auth error'));
            }
            if (code == 404) {
                return callback(new Error('Not found'));
            }
            if (code == 409) {
                return callback(new Error('Conflict'))
            }
            if (code == 400) {
                return callback(new Error('Bad Destination'))
            }
            if (responseType && typeof responseType.write == 'function') {
                res.pipe(responseType);
            } else {
                var response = '';
                res.setEncoding(responseType || 'binary');
                res.on('data', function(chunk) {
                    response += chunk;
                });
            }
            res.on('end', function() {
                callback(null, response);
            });
        });
        req.on('error', function(err) {
            callback(err);
        });
        if (body && typeof body.pipe == 'function') {
            body.pipe(req);
        } else {
            if (body) {
                req.write(body);
            }
            req.end();
        }

        var timeoutTimer = setTimeout(function () {
            var connectTimeout = req.socket && req.socket.readable === false;
            req.abort();
            var e = new Error('ETIMEDOUT');
            e.code = 'ETIMEDOUT';
            e.connect = connectTimeout;
            req.emit('error', e);
        }, that.timeout);

        req.on('socket', function (socket) {
            socket.setTimeout(that.timeout);
            socket.on('timeout', function() {
                req.abort();
            });
        });
    }

    _getPublicUrl(err, response, callback){
        if (err) {
            return callback(err);
        }
        try {
            new DomJS.DomJS().parse(response, function(err, root) {
                var publicUrl = getNodeValue(root, 'public_url');
                return callback(null, publicUrl);
            });
        } catch (e) {
            return callback(e);
        }
    }
};

function getNodeValue(root, nodeName) {
    var nodes = getNodes(root, nodeName);
    return nodes.length ? nodes[0].text() : '';
}

function getNodes(root, nodeName) {
    var res = [];
    root.children.forEach(function(node) {
        if (node instanceof DomJS.Element) {
            if (nodeName == '*' || node.name == nodeName) {
                res.push(node);
            }
            [].push.apply(res, getNodes(node, nodeName));
        }
    }, this);
    return res;
}
