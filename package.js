Package.describe({
    name: 'malibun23:yandexdisk',
    version: '0.0.4',
    summary: 'YandexDisk',
    git: '',
    documentation: 'README.md'
});

Npm.depends({
    "dom-js":"0.0.9",
    "xml2js":"0.4.19"
});

Package.onUse(function(api) {
    api.versionsFrom('1.2.1');
    api.use('ecmascript');
    api.use('underscore');
    api.use('malibun23:stack@0.0.20');

    api.addFiles(
        [
            'lib/yandexdisk.js'
        ],['server']
    );

    api.export(
        [
            'YandexDisk'
        ]
        , ['server']
    );
});

