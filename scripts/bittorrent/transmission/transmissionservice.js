'use strict';

angular.module('torrentApp')
    .service('transmissionService', ["$http", "$q", "TorrentT", "transmissionConfig", "notificationService", function($http, $q, TorrentT, transmissionConfig, $notify) {

    const URL_REGEX = /^(https?)\:\/\/((?:(?:[^:\/?#]+)+\.)?([^\.:\/?#]+\.([a-z]+)))(?:\:([0-9]+))?([\/]{0,1}[^?#]*)(\?[^#]*|)(#.*|)$/

    /*
     * Please rename all occurences of __serviceName__ (including underscores) with the name of your service.
     * Best practise is naming your service starting with the client name in lower case followed by 'Service'
     * (remember capital 'S' e.g qbittorrentService for qBittorrent, utorrentService for µTorrent ect.).
     * The real name of your client for display purposes can be changes in the field 'this.name' below.
     */
    this.name = 'Transmission';

    /*
     * Good practise is keeping a configuration object for your communication with the API
     */
    const config = {
        ip: '',
        port: '',
        session: undefined,
        encoded: '',
    }

    const fields = transmissionConfig.fields;

    function url() {
        var ip, port, path;
        if (arguments.length <= 1){
            ip = config.ip;
            port = config.port;
            path = arguments[0] || "";
        } else {
            ip = arguments[0]
            port = arguments[1]
            path = arguments[2] || "";
        }
        return `http://${ip}:${port}/transmission/rpc${path}`;
    }

    function updateSession(session) {
        if (!session) return;
        config.session = session;
    }

    function saveConnection(ip, port, encoded, session) {
        config.ip = ip;
        config.port = port;
        config.encoded = encoded;
        config.session = session;
    }

    /**
     * Connect to the server upon initial startup, changing connection settings ect. The function
     * should return a promise that the connection was successfull. A standard http timeout of 5 seconds
     * must be implemented. When successfull the service should save login details for later use.
     * @param {string} ip
     * @param {integer} port
     * @param {string} user
     * @param {string} password
     * @return {promise} connection
     */
    this.connect = function(ip, port, user, pass) {
        var defer = $q.defer();
        var encoded = new Buffer(`${user}:${pass}`).toString('base64');

        $http.get(url(ip,port),{
            timeout: 5000,
            headers: {
                'Authorization': "Basic " + encoded
            }
        }).then(function(response) {
            var session = response.headers('X-Transmission-Session-Id');
            saveConnection(ip, port, encoded, session);
            defer.resolve(response);
        }).catch(function(response){
            if(status === 409){
                var session = response.headers('X-Transmission-Session-Id');
                saveConnection(ip, port, encoded, session);
                return defer.resolve(response);
            }
            defer.reject(response);
        });

        return defer.promise;
    }

    /**
     * Return any new information about torrents to be rendered in the GUI. Should return a
     * promise with the required information to be updated. Will be executed by controllers
     * very frequently. You can find a template of the data to be returned in the function.
     * Here you will need:
     *      labels {array}: array of string of each label
     *      all {array}: array of objects inherited from 'AbstractTorrent' that are not currently known.
     *              This means they have just been added or never seen before since the last startup.
     *      changed {array}: array of objects inherited from 'AbstractTorrent' that have allready been seend before.
     *              This means they may contain partial information in which case they ar merged with any present infomation.
     *      deleted {array}: array of string containg the hashes of which torrents to be removed from the list in the GUI.
     * @return {promise} data
     */
    this.torrents = function() {
        var defer = $q.defer();

        // downloadedEver and uploadedEver continue to count the second time you download that torrent.


        /*var fields = ['id','name','totalSize','percentDone', 'downloadedEver',
        'uploadedEver', 'uploadRatio','rateUpload','rateDownload','eta','comment',
        'peersConnected','maxConnectedPeers','peersGettingToUs','seedsGettingFromUs',
        'queuePosition','status','addedDate','doneDate','downloadDir','recheckProgress',
        'isFinished','priorities'];
        */
        var data = {

            "arguments": {
	               "fields": fields
               },
            "method": "torrent-get"
	     }

        $http.post(url(),data,{
            headers:{
                'Authorization':'Basic ' + config.encoded,
                'X-Transmission-Session-Id': config.session
            }
        }).success(function(data, status, headers) {
            var session = headers('X-Transmission-Session-Id');
            updateSession(session);
            defer.resolve(processData(data));
        }).error(function(err){
            defer.reject(err);
        });

        return defer.promise;

    }

    function processData(data){
        var torrents = {
            dirty: true,
            labels: [],
            all: [],
            changed: [],
            deleted: [],
            trackers: []
        };
        torrents.all = data.arguments.torrents.map(build);
        torrents.trackers = getTrackers(torrents.all)
        return torrents;
    }

    function build(data){
        return new TorrentT(data);
    }

    function getTrackers(torrents) {
        let trackers = new Set()
        torrents.forEach((torrent) => {
            torrent.trackers.forEach((tracker) => trackers.add(tracker))
        })
        return Array.from(trackers).map((tracker) => parseUrl(tracker).hostname)
    }

    function parseUrl(url) {
        var match = url.match(URL_REGEX)
        return match && {
            protocol: match[1],
            domain: match[2],
            hostname: match[3],
            extension: match[4],
            port: match[5],
            path: match[6],
            params: match[7],
            hash: match[8]
        }
    }

    /**
     * Add a torrent to the client by sending a magnet link to the API. Should return
     * a promise that the torrent has been added successfully to the client.
     * @param {string} magnetURL
     * @return {promise} isAdded
     */
    this.addTorrentUrl = function(magnet) {
        // Torrent-add
        var data = {
            "arguments": {
                "filename": magnet
            },
            "method": "torrent-add"
        }

        return $http.post(url(), data, {
            headers:{
                'Authorization':'Basic ' + config.encoded,
                'X-Transmission-Session-Id': config.session
            }
        }).then(function(response){
            var session = response.headers('X-Transmission-Session-Id');
            updateSession(session);
            if ('torrent-duplicate' in response.data.arguments) return $q.reject('torrentDuplicate')
            return $q.resolve();
        }).catch(function(err){
            if (err === 'torrentDuplicate'){
                $notify.alert('Duplicate!',' This torrent is already added');
            } else {
                $notify.alert('Undefined error!', err);
            }
            return $q.reject()

        })

    }



    /**
     * Add a torrent file with the .torrent extension to the client through the API. Should
     * return a promise that the torrent was added sucessfully. File data is given as a blob
     * more information here: https://developer.mozilla.org/en/docs/Web/API/Blob. You may use
     * the existing implementation as a helping hand
     * @param {blob} filedata
     * @param {string} filename
     * @return {promise} isAdded
     */
    this.uploadTorrent = function(buffer) {
        var defer = $q.defer();
        var blob = new Blob([buffer]);
        var base64data = '';

        // Convert blob file object to base64 encoded.
        var reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = function() {
            /* The use of split is necessary because the reader returns the type of the data
             * in the same string as the actual data, but we only need to send the actual data.*/
            base64data = reader.result.split(',')[1];

            // Torrent-add
            var data = {
               "arguments": {
                   "metainfo": base64data
               },
               "method": "torrent-add"
               }

            $http.post(url(), data, {
                headers: {
                    'Authorization': 'Basic ' + config.encoded,
                    'X-Transmission-Session-Id': config.session
                }
            }).then(function(response){
                var session = response.headers('X-Transmission-Session-Id');
                updateSession(session);
                if ('torrent-duplicate' in response.data.arguments) return $q.reject('torrentDuplicate');
                defer.resolve();
            }).catch(function(err){
                if (err === 'torrentDuplicate'){
                    $notify.alert('Duplicate!',' This torrent is already added.');
                } else {
                    $notify.alert('Undefined error!', err.msg);
                }
                defer.reject();

            })
           }

            return defer.promise;

    }

    function doAction(command, torrents, mutator, value) {
        if (!Array.isArray(torrents)) {
            return $notify.alert('Error', 'Action was passed incorrect arguments')
        }

        var hashes = torrents.map(function(torrent) {
            return torrent.hash
        })

        var data = {
            "arguments": {},
            "method": command
        }

        if (hashes.length){
            data.arguments.ids = hashes;
        }

        if (mutator) {
            data.arguments[mutator] = value;
        }

        return $http.post(url(), data, {
            headers: {
                'Authorization': 'Basic ' + config.encoded,
                'X-Transmission-Session-Id': config.session
            }
        })

    }

    function doGlobalAction(command) {
        doAction(command, []);
    }

    /**
     * Example action function. You will have to implement several of these to support the various
     * actions in your bittorrent client. Each action is supplied an array of the hashes on which
     * the action should be applied.
     * @param {array} hashes
     * @return {promise} actionIsDone
     */
    this.start = function(torrents) {
        return doAction('torrent-start', torrents);
    }

    this.stop = function(torrents) {
        return doAction('torrent-stop', torrents);
    }

    this.verify = function(torrents) {
        return doAction('torrent-verify', torrents);
    }

    this.pauseAll = function() {
        return doGlobalAction('torrent-stop');
    }

    this.resumeAll = function() {
        return doGlobalAction('torrent-start');
    }

    this.queueUp = function(torrents) {
        return doAction('queue-move-up', torrents);
    }

    this.queueDown = function(torrents) {
        return doAction('queue-move-down', torrents);
    }

    this.remove = function(torrents) {
        return doAction('torrent-remove', torrents)
    }

    this.removeAndLocal = function(torrents) {
        return doAction('torrent-remove', torrents, 'delete-local-data', true)
    }

    /**
     * Whether the client supports sorting by trackers or not
     */
    this.enableTrackerFilter = true

    /**
     * Represents the buttons and GUI elements to be displayed in the top navigation bar of the windows.
     * You may customize the GUI to your liking or to better accommodate the specific bittorrent client.
     * Every action must have a click function that corresponds to an action like the one showed above.
     * An object in the array should consist of the following information:
     *      label [string]: Name of the button/element
     *      type [string]: Can be 'button' or 'dropdown' or 'labels'
     *      color [string]: Can be 'red', 'orange', 'yellow', 'olive', 'green', 'teal', 'blue', 'violet', 'purple', 'pink', 'brown', 'grey', 'black'
     *      click [function]: The function to be executed when the when the button/element is pressed
     *      icon [string]: The icon of the button. See here: http://semantic-ui.com/elements/icon.html
     */
    this.actionHeader = [
        {
            label: 'Start',
            type: 'button',
            color: 'green',
            click: this.start,
            icon: 'play'
        },
        {
            label: 'Stop',
            type: 'button',
            color: 'red',
            click: this.stop,
            icon: 'pause'
        },
        {
            label: 'More',
            type: 'dropdown',
            color: 'blue',
            icon: 'plus',
            actions: [
                {
                    label: 'Pause All',
                    click: this.pauseAll
                },
                {
                    label: 'Resume All',
                    click: this.resumeAll
                }
            ]
        }
    ]

    /**
     * Represents the actions available in the context menu. Can be customized to your liking or
     * to better accommodate your bittorrent client. Every action must have a click function implemented.
     * Each element has an:
     *      label [string]: The name of the action
     *      click [function]: The function to be executed when clicked
     *      icon [string]: The icon of the action. See here: http://semantic-ui.com/elements/icon.html
     */
    this.contextMenu = [
        {
            label: 'Start',
            click: this.start,
            icon: 'play'
        },
        {
            label: 'Pause',
            click: this.stop,
            icon: 'pause'
        },
        {
            label: 'Verify',
            click: this.verify,
            icon: 'checkmark'
        },
        {
            label: 'Move Up Queue',
            click: this.queueUp,
            icon: 'arrow up'
        },
        {
            label: 'Move Queue Down',
            click: this.queueDown,
            icon: 'arrow down'
        },
        {
            label: 'Remove',
            menu: [
                {
                    label: 'Torrent',
                    icon: 'remove',
                    click: this.remove
                },
                {
                    label: 'Torrent and Local Data',
                    icon: 'remove',
                    click: this.removeAndLocal
                }
            ]
        }
    ];

}]);
