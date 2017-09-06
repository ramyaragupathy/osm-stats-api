const Promise = require("bluebird");
const Redis = require("ioredis");
const lockingCache = require("locking-cache");
const R = require("ramda");
const request = require("request-promise");

const Hashtag = require("../models/Hashtag");
const bookshelf = require("../db/bookshelf_init");

const FORGETTABLE_URL =
  process.env.FORGETTABLE_URL || "http://forgettable:8080";
const REDIS_URL = process.env.REDIS_URL || "redis://redis/";

const redis = new Redis(REDIS_URL);

const lockedFetch = lockingCache({
  maxAge: 1000 * 20
});

function getUserStats(hashtag) {
  const { knex } = bookshelf;

  const subquery = knex("changesets_hashtags")
    .join("hashtags", "hashtags.id", "changesets_hashtags.hashtag_id")
    .select("changeset_id")
    .where("hashtags.hashtag", hashtag);

  return knex
    .select(
      "user_id",
      "name",
      knex.raw("COUNT(*) as changesets"),
      knex.raw("SUM(road_km_mod + road_km_add) as roads"),
      knex.raw("SUM(building_count_add + building_count_mod) as buildings"),
      knex.raw(
        `SUM(building_count_add + building_count_mod +
                          road_count_add + road_count_mod +
                          waterway_count_add + poi_count_add) as edits`
      ),
      knex.raw("MAX(changesets.created_at) as created_at")
    )
    .from("changesets")
    .join("users", "changesets.user_id", "users.id")
    .where("changesets.id", "in", subquery)
    .groupBy("name", "user_id")
    .then(rows =>
      R.map(
        row => ({
          name: row.name,
          user_id: row.user_id,
          edits: Number(row.edits),
          changesets: Number(row.changesets),
          roads: Number(Number(row.roads).toFixed(3)),
          buildings: parseInt(row.buildings, 10),
          created_at: row.created_at
        }),
        rows
      )
    );
}

const getCachedUserStats = lockedFetch((hashtag, lock) =>
  lock(`user-stats:${hashtag}`, unlock =>
    getUserStats(hashtag)
      .then(stats => unlock(null, stats))
      .catch(err => unlock(err))
  )
);

module.exports = [
  {
    method: "GET",
    path: "/hashtags/{id}/users",
    handler: (req, res) => getCachedUserStats(req.params.id, res)
  },
  {
    method: "GET",
    path: "/hashtags/{id}/map",
    handler: (req, res) =>
      redis
        .lrange(`osmstats::map::#${R.toLower(req.params.id)}`, 0, -1)
        .then(elements => elements.map(JSON.parse))
        .then(res)
        .catch(res)
  },
  {
    method: "GET",
    path: "/hashtags",
    handler: (req, res) =>
      Promise.all([
        Hashtag.fetchAll({ columns: ["hashtag"] }),
        request(`${FORGETTABLE_URL}/nmostprobable?distribution=hashtags&N=5`)
      ])
        .then(results => {
          const hashtags = results[0];
          const distribution = JSON.parse(results[1]);
          const serialized = hashtags.toJSON();
          const hashtaglist = R.map(R.prop("hashtag"), serialized);
          return {
            hashtags: hashtaglist,
            trending: R.map(R.prop("bin"), distribution.data.data)
          };
        })
        .then(res)
        .catch(res)
  }
];
