/**
 * Manage games and reviews
 */
var db = require('./db')
  , config = require('./config')
  , realtime = require('./realtime')
  , async = require('async')
  , _ = require('underscore')
  , GameEngine = require('../assets/js/gameEngine')
  , routes = {}
  , staleGamesTimeouts = {}
   // Not persisted, will be lost upon restart but not worth persisting
  , undos = {}
  , gamesDeads = {}
  ;


// ===== WEB ROUTES =====

/**
 * Display play page
 */
routes.game = function (req, res) {
  db.games.findOne({ _id: req.params.id }, function (err, game) {
    if (err || !game) { return res.redirect(302, '/'); }
    res.locals.game = game;
    if (req.session.user._id === game.blackPlayerId) { res.locals.canPlay = 'black'; }
    if (req.session.user._id === game.whitePlayerId) { res.locals.canPlay = 'white'; }

    if (game.status === db.games.statuses.FINISHED && game.deads) {
      res.locals.markedDead = JSON.stringify(game.deads);
    } else if (gamesDeads[game._id]) {
      res.locals.markedDead = JSON.stringify(gamesDeads[game._id].deads);
    }

    getCPReviews(game._id, function (err, reviews) {
      res.locals.initialReviews = JSON.stringify(reviews);
      return res.render('game.jade');
    });
  });
};


/**
 * Create a new review of game
 * Default reviewer is the one who created the review
 */
routes.createReview = function (req, res) {
  if (!req.query || !req.query.gameId) { return res.status(403).send("No gameId querystring parameter supplied"); }

  db.games.findOne({ _id: req.query.gameId }, function (err, game) {
    if (err || !game) { return res.status(404).send("Couldn't find game with supplied gameId"); }

    var reviewData = { blackPlayerName: game.blackPlayerName
                     , whitePlayerName: game.whitePlayerName
                     , gameName: game.name
                     , gameId: req.query.gameId
                     , size: game.size
                     , handicap: game.handicap || 0
                     , reviewerId: req.session.user._id
                     , reviewerName: req.session.user.name
                     , moves: game.moves
                     , currentMoveNumber: game.currentMoveNumber
                     };

    db.reviews.insert(reviewData, function (err, review) {
      if (err) { return res.status(500).send("Couldn't create the review"); }

      return res.redirect(302, '/web/review/' + review._id);
    });
  });
};


/**
 * Display review page
 */
routes.review = function (req, res) {
  db.reviews.findOne({ _id: req.params.id }, function (err, review) {
    res.locals.game = review;   // Same page as the game page
    res.locals.canPlay = (req.session.user._id === review.reviewerId) ? 'both' : 'none';
    res.locals.reviewMode = true;
    return res.render('game.jade');
  });
};


/**
 * List of games being played
 */
routes.games = function (req, res) {
  getCurrentGames(function (err, games) {
    if (err) { return res.status(500).json({ unexpected: err }); }
    res.locals.games = JSON.stringify(games);
    return res.render('games.jade');
  });
};


/**
 * List of past games (only the first 20 are shown, then a load more button)
 */
routes.pastGames = function (req, res) {
  db.games.find({ status: db.games.statuses.FINISHED }, { moves: 0 }).sort({ createdAt: -1 }).limit(config.infiniteListBatchSize).exec(function (err, pastGames) {
    res.locals.games = JSON.stringify({ pastGames: pastGames });
    return res.render('past-games.jade');
  });
};

// ===== END OF WEB ROUTES =====

// ===== API ROUTES =====

/**
 * Return whole game state (used to synchronize client with server if connection was lost)
 */
routes.getGameStateApi = function (req, res) {
  db.games.findOne({ _id: req.params.id }, function (err, game) {
    if (err || !game) { return res.status(404).json({ message: "Game not found" }); }
    return res.status(200).json({ moves: game.moves, currentMoveNumber: game.currentMoveNumber });
  });
};


/**
 * Return whole review state (used to synchronize client with server if connection was lost)
 */
routes.getReviewStateApi = function (req, res) {
  db.review.findOne({ _id: req.params.id }, function (err, review) {
    if (err || !review) { return res.status(404).json({ message: "Review not found" }); }
    return res.status(200).json({ moves: review.moves, currentMoveNumber: review.currentMoveNumber });
  });
};


/**
 * More past games API
 */
routes.pastGamesApi = function (req, res) {
  var latestGameTime = req.query && req.query.before ? new Date(parseInt(req.query.before, 10)) : new Date();

  db.games.find({ status: db.games.statuses.FINISHED, createdAt: { $lt: latestGameTime } }, { moves: 0 }).sort({ createdAt: -1 }).limit(config.infiniteListBatchSize).exec(function (err, pastGames) {
    if (err) { return res.status(500).json({ error: err }); }
    return res.status(200).json({ pastGames: pastGames, noMore: pastGames.length !== config.infiniteListBatchSize });
  });
};


/**
 * Warn server that reviewer has changed focus
 */
routes.changeReviewFocusApi = function (req, res) {
  var currentMoveNumber = req.body.currentMoveNumber;

  // Check parameters

  db.reviews.findOne({ _id: req.params.id }, function (err, review) {
    if (err || !review) { return res.status(404).json({ message: "Review not found" }); }
    if (req.session.user._id !== review.reviewerId) { return res.status(401).json({ error: "You are not the reviewer" }); }

    // Async
    db.reviews.update({ _id: review._id }, { $set: { currentMoveNumber: currentMoveNumber } }, {}, function () { });

    var data = { currentMoveNumber: currentMoveNumber };
    realtime.broadcast('review.' + review._id + '.stateChanged', data);

    return res.status(200).json({});
  });
};


/*
 * GAME MODE
 * Warn server that a move was played
 * Server then broadcasts diff to all connected users
 * Sync issues are the clients responsibility
 */
routes.gamePlayApi = function (req, res) {
  var move = req.body.move;

  // TODO: Check parameters

  db.games.findOne({ _id: req.params.id }, function (err, game) {
    if (err || !game) { return res.status(404).json({ message: "Game not found" }); }
    if (req.session.user._id !== game.blackPlayerId && req.session.user._id !== game.whitePlayerId) { return res.status(401).json({ message: "You are not a player in this game" }); }

    // Might need to keep up to date in memory cache of gameEngines if this proves to be a bottleneck
    var gameEngine = new GameEngine({ size: game.size, handicap: game.handicap || 0 });
    gameEngine.replaceGameTree(GameEngine.Move.deserialize(game.moves));

    if (req.body.previousMoveN !== gameEngine.maxMoveNumber) { return res.status(403).json({ message: "Client is out of sync" }); }
    gameEngine.backToMove(req.body.previousMoveN);

    if (!(req.session.user._id === game.blackPlayerId && gameEngine.currentPlayer === GameEngine.players.BLACK) && !(req.session.user._id === game.whitePlayerId && gameEngine.currentPlayer === GameEngine.players.WHITE)) {
      return res.status(403).json({ message: "Playing out of turn" });
    }

    if (move.type === GameEngine.Move.types.STONE) {
      if (!gameEngine.isMoveValid(move.x, move.y)) {
        return res.status(403).json({ message: "You tried to play an invalid move" });
      }
    }

    var playedMove = gameEngine.play(move);
    var serializedMoves = gameEngine.movesRoot.serialize();

    db.games.update({ _id: game._id }, { $set: { moves: serializedMoves, currentMoveNumber: playedMove.n } }, {}, function () {
      // Only send move that was played. If a client is not in sync, he will request the whole game tree
      // TODO: don't send this data to player who just played
      var data = { playedMove: playedMove.getOwnData(), currentMoveNumber: playedMove.n, parentMoveNumber: playedMove.parent.n };
      realtime.broadcast('game.' + game._id + '.stateChanged', data);

      // Done asynchronously as the caller of this API endpoint is not looking at the games page
      if (gameEngine.currentMove.type === GameEngine.Move.types.RESIGN) {
        var result = gameEngine.currentMove.player === GameEngine.players.BLACK ? db.games.results.WHITE_WIN : db.games.results.BLACK_WIN;
        var resultExpanded = gameEngine.currentMove.player === GameEngine.players.BLACK ? "Black resigned on move " : "White resigned on move ";
        resultExpanded += gameEngine.currentMove.depth;
        db.games.update({ _id: game._id }, { $set:{ status: db.games.statuses.FINISHED, result: result, resultExpanded: resultExpanded } }, {}, function () {
          realtime.emit('game.finished', { gameId: game._id });   // Using realtime event emitter even if nothing to do with io, for consistency
        });
      }

      return res.status(200).json({})
    });
  });
};


/*
 * REVIEW MODE
 * Warn server that a move was played
 * Server then broadcasts diff to all connected users
 * Sync issues are the clients responsibility
 * TODO: handle duplication with above route
 */
routes.reviewPlayApi = function (req, res) {
  var move = req.body.move;

  // TODO: Check parameters

  db.reviews.findOne({ _id: req.params.id }, function (err, review) {
    if (err || !review) { return res.status(404).json({ message: "Review not found" }); }
    if (req.session.user._id !== review.reviewerId) { return res.status(401).json({ message: "You are not the reviewer" }); }

    // Might need to keep up to date in memory cache of gameEngines if this proves to be a bottleneck
    var gameEngine = new GameEngine({ size: review.size, handicap: review.handicap || 0 });
    gameEngine.replaceGameTree(GameEngine.Move.deserialize(review.moves));

    if (req.body.previousMoveN > gameEngine.maxMoveNumber) { return res.status(403).json({ message: "Client is out of sync" }); }
    gameEngine.backToMove(req.body.previousMoveN);

    if (move.type === GameEngine.Move.types.STONE) {
      if (!gameEngine.isMoveValid(move.x, move.y)) {
        return res.status(403).json({ message: "You tried to play an invalid move" });
      }
    }

    var playedMove = gameEngine.play(move);
    var serializedMoves = gameEngine.movesRoot.serialize();
    db.reviews.update({ _id: review._id }, { $set: { moves: serializedMoves, currentMoveNumber: playedMove.n } }, {}, function () {
      // TODO: handle err

      // Only send move that was played. If a client is not in sync, he will request the whole game tree
      // TODO: don't send this data to player who just played
      var data = { playedMove: playedMove.getOwnData(), currentMoveNumber: playedMove.n, parentMoveNumber: playedMove.parent.n };
      realtime.broadcast('review.' + review._id + '.stateChanged', data);

      return res.status(200).json({})
    });
  });
};


/**
 * Ask for an undo. If an undo has already been asked for this move, trigger the undo.
 */
routes.askForUndo = function (req, res) {
  db.games.findOne({ _id: req.params.id }, function (err, game) {
    if (err || !game) { return res.status(404).json({ message: "Game not found" }); }
    if (req.session.user._id !== game.blackPlayerId && req.session.user._id !== game.whitePlayerId) { return res.status(401).json({ message: "You are not a player in this game" }); }

    var gameEngine = new GameEngine({ size: game.size, handicap: game.handicap || 0 });
    gameEngine.replaceGameTree(GameEngine.Move.deserialize(game.moves));
    gameEngine.backToMove(gameEngine.movesRoot.getMaxN());

    var requester = req.session.user._id === game.blackPlayerId ? GameEngine.players.BLACK : GameEngine.players.WHITE;

    if (undos[game._id] && game.currentMoveNumber - undos[game._id].moveNumber <= 1 && undos[game._id].requester !== requester) {
      var toUndoNumber = undos[game._id].moveNumber;
      gameEngine.undo(undos[game._id].moveNumber);
      delete undos[game._id];

      db.games.update({ _id: game._id }, { $set: { moves: gameEngine.movesRoot.serialize(), currentMoveNumber: gameEngine.currentMove.n } }, {}, function () {
        realtime.broadcast('game.' + game._id + '.undo', { undone: toUndoNumber });
        return res.status(200).json({});
      });
    } else {
      var requestingFor;
      if (gameEngine.currentMove.player === requester) {
        requestingFor = game.currentMoveNumber;
      } else {
        if (gameEngine.currentMove.parent) { requestingFor = gameEngine.currentMove.parent.n; }
      }
      if (!requestingFor || requestingFor === 0) { return res.status(401).json({ error: "Can't request undo for unplayed move" }); }
      undos[game._id] = { requester: requester, moveNumber: requestingFor };
      realtime.broadcast('game.' + game._id + '.undoRequest', { requester: requester, moveNumber: requestingFor });
      return res.status(200).json({});
    }
  });
};


/**
 * Mark a group as dead
 */
routes.markAsDead = function (req, res) {
  db.games.findOne({ _id: req.params.id }, function (err, game) {
    if (err || !game) { return res.status(404).json({ message: "Game not found" }); }
    if (req.session.user._id !== game.blackPlayerId && req.session.user._id !== game.whitePlayerId) { return res.status(401).json({ message: "You are not a player in this game" }); }

    if (!gamesDeads[game._id]) { gamesDeads[game._id] = { deads: [] }; }

    var _d = {}, changed = false;
    gamesDeads[game._id].deads.forEach(function (i) { _d[i.x + '-' + i.y] = true; });
    req.body.deads.forEach(function (i) {
      if ((!_d[i.x + '-' + i.y] && req.body.areDead) || (_d[i.x + '-' + i.y] && !req.body.areDead)) {
        changed = true;
      }
      _d[i.x + '-' + i.y] = req.body.areDead;
    });
    gamesDeads[game._id].deads = [];
    Object.keys(_d).forEach(function (k) {
      if (_d[k]) {
        gamesDeads[game._id].deads.push({ x: parseInt(k.split('-')[0], 10), y: parseInt(k.split('-')[1], 10) });
      }
    });

    if (changed) {
      if (gamesDeads[game._id].okFor) { realtime.broadcast('game.' + game._id + '.okFor.change', { okFor: 'none' }); }
      delete gamesDeads[game._id].okFor;
    }

    realtime.broadcast('game.' + game._id + '.deads.change', { deads: gamesDeads[game._id].deads });
    return res.status(200).json({});
  });
};


/**
 * Notify server that you agree with the dead stones count
 */
routes.agreeOnDeads = function (req, res) {
  db.games.findOne({ _id: req.params.id }, function (err, game) {
    if (err || !game) { return res.status(404).json({ message: "Game not found" }); }
    if (req.session.user._id !== game.blackPlayerId && req.session.user._id !== game.whitePlayerId) { return res.status(401).json({ message: "You are not a player in this game" }); }

    if (!gamesDeads[game._id]) { gamesDeads[game._id] = { deads: [] }; }

    var newOkFor;
    if (req.session.user._id === game.blackPlayerId) {
      newOkFor = GameEngine.players.BLACK;
    } else {
      newOkFor = GameEngine.players.WHITE;
    }

    if (gamesDeads[game._id].okFor && gamesDeads[game._id].okFor !== newOkFor) {
      var gameEngine = new GameEngine({ size: game.size, handicap: game.handicap || 0 });
      gameEngine.replaceGameTree(GameEngine.Move.deserialize(game.moves));
      gameEngine.backToMove(gameEngine.movesRoot.getMaxN());

      var scores = gameEngine.getScores(gamesDeads[game._id].deads);
      var result = db.games.results.DRAW;
      var resultExpanded = "Draw - same score";
      if (scores.blackScore > scores.whiteScore) {
        result = db.games.results.BLACK_WIN;
        resultExpanded = "B+" + (scores.blackScore - scores.whiteScore);
      }
      if (scores.blackScore < scores.whiteScore) {
        result = db.games.results.WHITE_WIN;
        resultExpanded = "W+" + (scores.whiteScore - scores.blackScore);
      }

      db.games.update({ _id: game._id }, { $set:{ status: db.games.statuses.FINISHED, result: result, resultExpanded: resultExpanded, deads: gamesDeads[game._id].deads } }, {}, function () {
        realtime.emit('game.finished', { gameId: game._id });   // Using realtime event emitter even if nothing to do with io, for consistency
        realtime.broadcast('game.' + game._id + '.bothOk');
      });
    } else {
      gamesDeads[game._id].okFor = newOkFor;
      realtime.broadcast('game.' + game._id + '.okFor.change', { okFor: newOkFor });
    }

    return res.status(200).json({});
  });
};


// ===== END OF API ROUTES =====

// ===== UTIITIES =====

/**
 * Give the lists of current and stale games
 */
function getCurrentGames (cb) {
  db.games.find({ status: db.games.statuses.ONGOING }, { moves: 0 }, function (err, currentGames) {
    if (err) { return cb(err); }
    db.games.find({ status: db.games.statuses.STALE }, { moves: 0 }, function (err, staleGames) {
      if (err) { return cb(err); }
      return cb(null, { currentGames: currentGames, staleGames: staleGames });
    });
  });
}


/**
 * Give the lists of current and past reviews for a specific game
 */
function getCPReviews (gameId, cb) {
  var openReviewsId = realtime.getOpenReviewsIds(gameId);
  db.reviews.find({ gameId: gameId }, { _id: 1, reviewerName: 1 }, function (err, reviews) {
    if (err) { return cb(err); }

    var data = { activeReviews: _.filter(reviews, function (r) { return openReviewsId.indexOf(r._id) !== -1; })
               , inactiveReviews: _.filter(reviews, function (r) { return openReviewsId.indexOf(r._id) === -1; })
               };

    return cb(null, data);
  });
}


/**
 * Mark a game as stale and finish it after some time
 * @param {delay} - Optional, in ms. Default is in the config, time to wait before force finishing the game
 */
function staleGame (gameId, delay) {
  db.games.findOne({ _id: gameId }, function (err, game) {
    if (err || !game) { return; }
    if (game.status === db.games.statuses.FINISHED) { return; }

    db.games.update({ _id: gameId }, { $set: { status: db.games.statuses.STALE } }, {}, function () {
      updateGamesLists();

      // If game is still stale after the stale delay, finish it
      staleGamesTimeouts[gameId] = setTimeout(function () {
        db.games.update({ _id: gameId, status: db.games.statuses.STALE }, { $set: { status: db.games.statuses.FINISHED, result: db.games.results.DRAW, resultExpanded: "Both players left" } }, {}, function () {
          updateGamesLists();
        });
      }, delay || config.staleGameCleanupDelay);
    });
  });
}


/**
 * Unstale a game
 */
function unstaleGame (gameId) {
  db.games.update({ _id: gameId, status: db.games.statuses.STALE }, { $set: { status: db.games.statuses.ONGOING } }, {}, function () {
    clearTimeout(staleGamesTimeouts[gameId]);
    updateGamesLists();
  });
}

// ===== END OF UTIITIES =====
// ===== REAL TIME EVENTS =====

/**
 * Upon change in active reviews, notify all watchers of the corresponding game page
 */
realtime.on('openReviews.change', function (msg) {
  getCPReviews(msg.gameId, function (err, data) {
    if (err) { return; }
    realtime.broadcast('game.' + msg.gameId + '.reviewsChange', data);
  });
});


/**
 * Update lists of games on games page if a game is created or finished
 */
function updateGamesLists () {
  getCurrentGames(function (err, games) {
    if (err) { return; }
    realtime.broadcast('games.change', games);
  });
}
realtime.on('game.created', updateGamesLists);
realtime.on('game.finished', updateGamesLists);


/**
 * When someone leaves a game, check there is still someone connected otherwise game is stale
 * TODO: maybe stale game if no more players but observers still there
 */
realtime.on('openGame.leave', function (msg) {
  var usersIds = Object.keys(realtime.getGamePlayersSockets(msg.gameId));
  if (usersIds.length === 0) {
    staleGame(msg.gameId);
  }
});


/**
 * Unstale game when someone joins it
 */
realtime.on('openGame.join', function (msg) {
  var usersIds = Object.keys(realtime.getGamePlayersSockets(msg.gameId));
  if (usersIds.length !== 0) {
    unstaleGame(msg.gameId);
  }
});


/**
 * Remove any transient variables upon game finish to prevent memory leaks
 */
realtime.on('game.finished', function (msg) {
  delete undos[msg.gameId];
  delete gamesDeads[msg.gameId];
});


/**
 * When a challenge is accepted, create and launch game
 */
realtime.on('challenge.accepted', function (msg) {
  var challenge = msg.challenge;

  db.users.findOne({ _id: challenge.currentChallengerId }, function (err, challenger) {
    var gameData = { _id: challenge._id
      , blackPlayerId: challenge.creatorId
      , blackPlayerName: challenge.creatorName
      , whitePlayerId: challenger._id
      , whitePlayerName: challenger.name
      , status: db.games.statuses.ONGOING
      , name: challenge.name
      , size: parseInt(challenge.size, 10)
      , handicap: challenge.handicap ? parseInt(challenge.handicap, 10) : 0
    };

    if (challenge.creatorColor === 'black') {
      gameData.blackPlayerId = challenge.creatorId;
      gameData.blackPlayerName = challenge.creatorName;
      gameData.whitePlayerId = challenger._id;
      gameData.whitePlayerName = challenger.name;
    } else {
      gameData.blackPlayerId = challenger._id;
      gameData.blackPlayerName = challenger.name;
      gameData.whitePlayerId = challenge.creatorId;
      gameData.whitePlayerName = challenge.creatorName;
    }

    db.games.insert(gameData, function (err, newGame) {
      db.challenges.remove({ _id: challenge._id }, {}, function () {
        realtime.broadcast('game.' + newGame._id + '.created');
        realtime.emit('game.created');   // Using realtime event emitter even if nothing to do with io, for consistency
      });
    });
  });
});


// ===== END OF REAL TIME EVENTS =====



// Check stale games upon startup
db.games.find({ status: db.games.statuses.STALE }, function (err, games) {
  var now = Date.now();

  if (err) { return; }
  games.forEach(function (game) {
    // Remaining time until force finish, minimum 5s as a grace period to let socket reconnect
    var delay = Math.max(5000, config.staleGameCleanupDelay - (now - game.updatedAt.getTime()));
    staleGame(game._id, delay);
  });
});


// Interface
module.exports = routes;
