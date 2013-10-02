#!/bin/env node

var http        = require('http');
var fs          = require('fs');
var path        = require('path');
var async       = require('async');
var socketio    = require('socket.io');
var express     = require('express');
var db          = require('./db/db');
var preferences = new db.ns('preferences');
var roomsDb     = new db.ns('rooms');
var app         = require('./helpers/app');
var router      = express();
var server      = http.createServer(router);
var io          = socketio.listen(server);

var sockets     = [];
var rooms       = {};
fs.readdir(__dirname+'/db/rooms', function(err,files){
    if (err) console.log(err);
    files.forEach(function(fineName){
        var roomName = fineName.replace('.json','');
        roomsDb.get( roomName , function(data) {
            rooms[roomName] = data;
        });
    });
});
router.use(express.static(path.resolve(__dirname, 'client')));

/* Heroku doesn't support websockets on the Cedar stack yet
io.configure(function () {
  io.set("transports", ["xhr-polling"]); 
  io.set("polling duration", 10); 
}); */

/*
 * Broadcast an event to all users
 */
function updateRecords() {
    async.map(
        sockets,
        function (socket, callback) {
            socket.get('profile', function (err, profile) {
                if (err) console.log(err);
                callback(null,{
                    id:     profile.id,
                    gid:    profile.gid,
                    name:   profile.name,
                    color:  profile.color,
                    image:  profile.image,
                    room:   profile.room
                });

            });
        },
        function (err, users) {
            io.sockets.emit('users', users);
        }
    );
};

io.on('connection', function (socket) {
    // emitOthers                                    socket.broadcast.emit(e,data);
    sockets.push(socket);
    var sid         = socket.id;

    socket.on('connect', function (profile) {
        try {
            if (profile == {} || !profile.gid) {
                var profile = app.defaultProfile(sid);
                socket.set('profile', profile );
                rooms[profile.room].users.push(profile);
                socket.join(profile.room);
                io.sockets.emit('rooms', rooms);
                socket.broadcast.to(profile.room).emit('roomUserJoin',profile);
                socket.emit('myProfile', profile);
                if(rooms[profile.room].messages) {
                    rooms[profile.room].messages.forEach(function (data) {
                        socket.emit('message', data);
                    });
                }
                updateRecords();
            } else if ( "undefined" !== typeof profile.gid ) {
                preferences.get( profile.gid, function(data) {
                    socket.set('profile', data, function (err) {
                        if (err) console.log(err);
                        rooms[profile.room].users.push(profile);
                        socket.join(profile.room);
                        io.sockets.emit('rooms', rooms);
                        socket.broadcast.to(profile.room).emit('roomUserJoin',profile);
                        socket.emit('myProfile', profile);
                        rooms[profile.room].messages.forEach(function (message) {
                            socket.emit('message', message);
                        });
                        updateRecords();
                    });
                });
            }
        } catch (e) {
            console.log(e);
        }
    });
    /*
     * Google Login
     */
    socket.on('login', function (gapiData) {
        socket.get('profile', function (err, profile) {
            if (err) console.log(err);
            try {
                profile.gid     = gapiData.id;
                profile.image   = gapiData.image.url;
                preferences.get( gapiData.id, function(data) {
                    if (data.color) profile.color = data.color;
                    if (data.name) profile.name = data.name;
                    if (data.settings) profile.settings = data.settings;
                    socket.set('profile', profile, function (err) {
                        if (err) console.log(err);
                        updateRecords();
                        socket.emit('myProfile', profile);
                        socket.broadcast.to(profile.room).emit('roomUserLogin',profile);
                    });
                    preferences.set( gapiData.id, profile );
                });
            } catch (e) {
                console.log(e);
            }
        });
    });
    /*
     * User Closed App
     */
    socket.on('disconnect', function () {
        sockets.splice(sockets.indexOf(socket), 1);
        socket.get('profile', function (err, profile) {
            if (err) console.log(err);
            try{ 
                rooms[profile.room].users.splice(rooms[profile.room].users.indexOf(profile), 1);
                updateRecords();
                socket.broadcast.to(profile.room).emit('roomUserLogout',profile);
                io.sockets.emit('rooms', rooms);
            } catch (e) {
                console.log(e);
            }
        });
    });
    /*
     * Rooms
     */
    socket.on('createRoom', function (room) {
        try{ 
            var roomName = app.camelcase(room.name);
            socket.get('profile', function (err, profile) {
                if (err) console.log(err);
                if ( !rooms[roomName] ) {
                    rooms[roomName] = {
                        id:         roomName,
                        name:       room.name,
                        private:    room.private,
                        password:   String( room.password || ''),
                        users:      [],
                        messages:   [],
                        created:    new Date(),
                        creator:    profile.gid,
                        admins:     [profile.gid]
                    };
                    roomsDb.set( roomName, rooms[roomName]  );
                    io.sockets.emit('rooms', rooms);
                } else {
                    socket.emit('info', room.name + ' exists');
                }
            });
        } catch (e) {
            console.log(e);
        }
    });
    socket.on('editRoom', function (room) {
        try{ 
            var roomName = app.camelcase(room.name);
            socket.get('profile', function (err, profile) {
                if (err) console.log(err);
                if (rooms[roomName].creator === profile.gid || rooms[roomName].admins.indexOf(profile.gid) >= 0 ) {
                    rooms[roomName].private = room.private;
                    rooms[roomName].password = room.password;
                    io.sockets.emit('rooms', rooms);
                } else {
                    socket.emit('info','not allowed to edit ' + room.name );
                }
            });
        } catch (e) {
            console.log(e);
        }
    });
    socket.on('joinRoom', function (room) {
        socket.get('profile', function(err,profile) {
            if (err) console.log(err);
            try {
                if ( ( !rooms[room.name].private ) || ( "undefined" !== typeof room.password && rooms[room.name].password === room.password ) ) {
                    rooms[profile.room].users.splice(rooms[profile.room].users.indexOf(profile), 1);
                    socket.leave(profile.room);
                    socket.broadcast.to(profile.room).emit(profile.room,'roomUserLeft',profile);
        
                    rooms[room.name].users.push(profile);
                    socket.join(room.name);
                    socket.broadcast.to(room.name).emit('roomUserJoin',profile);
        
                    profile.room = room.name;
                    socket.emit('myProfile', profile);
                    io.sockets.emit('rooms', rooms);
                    updateRecords();
                    rooms[profile.room].messages.forEach(function (data) {
                        socket.emit('message', data);
                    });
                } else {
                    socket.emit('info', "incorrect password");
                }
            } catch (e) {
                console.log(e);
            }
        });
    });
    /*
     * Profile Updates
     */
    socket.on('saveSettings', function (settings) {
        socket.get('profile', function(err,profile) {
            if (err) console.log(err);
            profile.settings = settings;
            socket.set('profile', profile, function (err) {
                if (err) console.log(err);
            });
            if (profile.gid) preferences.set( profile.gid, profile );
        });
    });
    socket.on('updateName', function (name) {
        socket.get('profile', function(err,profile) {
            if (err) console.log(err);
            profile.name = name;
            socket.set('profile', profile, function (err) {
                if (err) console.log(err);
                updateRecords();
            });
            if (profile.gid) preferences.set( profile.gid, profile );
        });
    });
    socket.on('updateColor', function (color) {
        socket.get('profile', function(err,profile) {
            if (err) console.log(err);
            profile.color = color;
            socket.set('profile', profile, function (err) {
                if (err) console.log(err);
                updateRecords();
            });
            if (profile.gid) preferences.set( profile.gid, profile );
        });
    });
    /*
     * New Message
     */
    socket.on('message', function (text) {
        var resp = {
          text: String(text || '')
        };
        socket.get('profile', function(err,profile) {
            if (err) console.log(err);
            try {
                resp.color = profile.color;
                resp.name  = profile.name;
                resp.image = profile.image;
                socket.broadcast.to(profile.room).emit('newMessage', resp );
                socket.emit( 'message' , resp );
                rooms[profile.room].messages.push(resp);
                if ( rooms[profile.room].messages.length > 10 ) {
                    rooms[profile.room].messages = rooms[profile.room].messages.slice(1,11);
                }
            } catch (e) {
                console.log(e);
            }
        });
    });

});
server.listen(process.env.PORT || 80, process.env.IP || "0.0.0.0", function(){
  var addr = server.address();
  console.log("Chat server listening at", addr.address + ":" + addr.port);
});
