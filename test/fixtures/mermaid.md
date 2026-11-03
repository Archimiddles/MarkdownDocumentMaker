# Diagrams: Mermaid rendering

## Flowchart

```mermaid
flowchart LR
    A[Client request] --> B{API key exempt?}
    B -- yes --> R[Route handler]
    B -- no --> C[Token bucket in Redis]
    C -- tokens left --> R
    C -- empty --> D[429 Too Many Requests<br/>Retry-After header]
    C -. Redis down .-> E[fail open: allow + metric]
    E --> R
```

Text after the flowchart keeps flowing normally.

## Sequence diagram

```mermaid
sequenceDiagram
    participant C as Client
    participant M as RateLimitMiddleware
    participant R as Redis
    participant H as Handler
    C->>M: GET /v1/search
    M->>R: EVAL take(rl:key, now)
    R-->>M: {allowed: 1, wait: 0}
    M->>H: forward request
    H-->>C: 200 OK + X-RateLimit-Remaining
    C->>M: GET /v1/search (burst)
    M->>R: EVAL take(rl:key, now)
    R-->>M: {allowed: 0, wait: 0.4}
    M-->>C: 429 + Retry-After: 1
```

## State diagram

```mermaid
stateDiagram-v2
    [*] --> Full
    Full --> Draining: requests arrive
    Draining --> Full: refill catches up
    Draining --> Empty: tokens < 1
    Empty --> Draining: refill tick
    Empty --> [*]: key expires
```

## Class diagram

```mermaid
classDiagram
    class TokenBucket {
        +int capacity
        +float refill_per_sec
        +take(redis, key, now) tuple
    }
    class RateLimitMiddleware {
        +RateLimitSettings settings
        +__call__(scope, receive, send)
    }
    RateLimitMiddleware --> TokenBucket : uses
```

## An invalid diagram

The block below has a syntax error and should fall back to showing the source with a note, not break the page.

```mermaid
flowchart LR
    A --> B --> --> C
    this is not valid [[
```

## A very wide diagram

```mermaid
flowchart LR
    S1[Step one with a fairly long label] --> S2[Step two with a fairly long label] --> S3[Step three with a fairly long label] --> S4[Step four with a fairly long label] --> S5[Step five with a fairly long label] --> S6[Step six] --> S7[Step seven] --> S8[Step eight]
```

Closing paragraph after all diagrams, with a task:

- [ ] Review the diagrams against the plan
