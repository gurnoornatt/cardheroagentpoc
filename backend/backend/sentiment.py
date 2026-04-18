"""
Reddit sentiment signal for the Conductor's decision tree.

Uses PRAW to search r/PokemonTCG for the card name.
Returns a score in [-1.0, 1.0]. Returns 0.0 on any error or missing creds.

Sentiment is cached per card name for ~1 hour to avoid PRAW rate limits.
"""

import logging
import time

logger = logging.getLogger(__name__)

MAX_SENTIMENT_WEIGHT = 0.10

# Module-level cache: {card_name: (score, timestamp)}
_cache: dict[str, tuple[float, float]] = {}
_CACHE_TTL_SECONDS = 3600  # 1 hour


def get_sentiment_score(card_name: str) -> float:
    """
    Search r/PokemonTCG for `card_name` and return a sentiment score in [-1.0, 1.0].

    Score = average of (upvote_ratio - 0.5) * 2 over the top 10 relevant posts.
    Returns 0.0 if Reddit creds are missing, PRAW errors out, or no posts found.
    """
    from newpoc.backend.config import REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT

    if not REDDIT_CLIENT_ID or not REDDIT_CLIENT_SECRET:
        logger.debug("[sentiment] No Reddit credentials configured — returning 0.0")
        return 0.0

    # Check cache
    now = time.time()
    if card_name in _cache:
        cached_score, cached_at = _cache[card_name]
        if now - cached_at < _CACHE_TTL_SECONDS:
            logger.debug(f"[sentiment] Cache hit for '{card_name}': {cached_score}")
            return cached_score

    try:
        import praw  # type: ignore

        reddit = praw.Reddit(
            client_id=REDDIT_CLIENT_ID,
            client_secret=REDDIT_CLIENT_SECRET,
            user_agent=REDDIT_USER_AGENT,
        )
        subreddit = reddit.subreddit("PokemonTCG")
        posts = list(
            subreddit.search(card_name, limit=10, sort="relevance", time_filter="month")
        )

        if not posts:
            _cache[card_name] = (0.0, now)
            return 0.0

        # upvote_ratio is in [0, 1]; map to [-1, 1] via (ratio - 0.5) * 2
        scores = [
            (p.upvote_ratio - 0.5) * 2.0
            for p in posts
            if hasattr(p, "upvote_ratio")
        ]
        if not scores:
            _cache[card_name] = (0.0, now)
            return 0.0

        avg = sum(scores) / len(scores)
        result = round(max(-1.0, min(1.0, avg)), 4)
        _cache[card_name] = (result, now)
        return result

    except Exception as exc:
        logger.warning(f"[sentiment] Error fetching Reddit sentiment for '{card_name}': {exc}")
        return 0.0


def compute_effective_weight(sentiment_score: float) -> float:
    """
    Effective weight = min(abs(sentiment_score) * 0.10, 0.10).
    Always non-negative. Direction (±) is applied by the caller.
    """
    return round(min(abs(sentiment_score) * 0.10, MAX_SENTIMENT_WEIGHT), 4)
