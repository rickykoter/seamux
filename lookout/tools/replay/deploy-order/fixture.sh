#!/usr/bin/env bash
# The deploy-order miss, rebuilt with neutral names (lookout/tools/replay).
#
#   fixture.sh <dir>
#
# Builds a git repo in <dir>: one commit on main, two on a feature branch
# checked out after it. Prints their shas as
# `base=<sha> c1=<sha> c2=<sha>`:
#
#   base  a message schema with additionalProperties false; a producer; two
#         consumers whose handlers implement a bus library interface. The
#         interface's run() validates every payload against the schema copy
#         each consumer's Dockerfile bakes into its image, then calls handle().
#   c1    the schema gains an optional "reason"; the producer writes it on
#         every message; the notifications consumer reads it.
#   c2    the fulfillment consumer acts on it (a consumer-only commit).
#
# A new producer next to a consumer image built before c1 fails every message
# at the schema check, whatever the decoders next to the hunks say about
# unknown keys. That is what a reviewer must find. Nothing here is real code
# from anywhere; dates and authors are fixed so the shas are stable.
set -euo pipefail
dir=${1:?usage: fixture.sh <dir>}
mkdir -p "$dir"
cd "$dir"
git init -q -b main .
export GIT_AUTHOR_NAME=replay GIT_AUTHOR_EMAIL=replay@example.com
export GIT_COMMITTER_NAME=replay GIT_COMMITTER_EMAIL=replay@example.com
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
git config commit.gpgsign false
git config core.hooksPath /dev/null

w() { mkdir -p "$(dirname "$1")"; cat > "$1"; }

# ---------------------------------------------------------------- base

w README.md <<'EOF'
# orders

Services that talk over the message bus. Each message carries a
`schema_path`; the bus library checks the payload against that schema under
the service's `schemas/` folder before the handler sees it.

- `services/pricing` decides an order and publishes `orders/v1/OrderDecided`.
- `services/fulfillment` and `services/notifications` consume it.
- `libs/bus` is the shared consumer library.
EOF

w schemas/orders/v1/OrderDecided.json <<'EOF'
{
  "$schema": "http://json-schema.org/draft-04/schema#",
  "title": "OrderDecided",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_path", "order_id", "tenant_id", "outcome"],
  "properties": {
    "schema_path": {
      "type": "string",
      "enum": ["orders/v1/OrderDecided.json"]
    },
    "order_id": {
      "type": "string"
    },
    "tenant_id": {
      "type": "string"
    },
    "outcome": {
      "$ref": "#/definitions/Outcome"
    }
  },
  "definitions": {
    "Outcome": {
      "type": "string",
      "enum": ["ACCEPT", "REJECT"]
    }
  }
}
EOF

w libs/bus/src/main/kotlin/com/example/bus/handlers/BusHandler.kt <<'EOF'
package com.example.bus.handlers

import com.example.bus.BusException
import com.example.bus.Result
import com.example.bus.models.BusMessage
import com.example.bus.validator.SchemaValidator
import com.example.bus.validator.SchemaValidationError
import mu.KotlinLogging
import software.amazon.awssdk.services.sqs.model.Message

private val logger = KotlinLogging.logger {}

open class ValidationError(description: String, cause: Throwable? = null) : BusException(description, cause)

interface BusHandler {
  fun validate(message: BusMessage): Result // Custom validation

  fun handle(message: BusMessage): Result // Handle the retrieved message

  private fun validateSchema(message: BusMessage): Boolean {
    SchemaValidator.validate(message.payload)
    return true
  }

  fun run(message: Message): Result {
    val busMessage = BusMessage(message)
    try {
      this.validateSchema(busMessage)
      this.validate(busMessage)
      return this.handle(busMessage)
    } catch (e: SchemaValidationError) {
      logger.warn("Message ${message.messageId()} failed schema validation: ${e.message}")
    } catch (e: ValidationError) {
      logger.warn("Message ${message.messageId()} failed custom validation: ${e.message}")
    } catch (e: Exception) {
      logger.error("Message ${message.messageId()} failed unexpectedly: ${e.message}")
    }
    return Result.Failure(BusException("Handler could not process message ${message.messageId()}"))
  }
}
EOF

w libs/bus/src/main/kotlin/com/example/bus/validator/SchemaValidator.kt <<'EOF'
package com.example.bus.validator

import com.example.bus.BusException
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.networknt.schema.JsonSchema
import com.networknt.schema.JsonSchemaFactory
import com.networknt.schema.SpecVersion
import java.io.File

open class SchemaValidationError(description: String, cause: Throwable? = null) : BusException(description, cause)

object SchemaValidator {
  private val cache = HashMap<String, JsonSchema>()
  // Relative to the working directory: the schemas/ folder the service's
  // image carries (see each service's Dockerfile).
  var rootSchemaPath: String = "schemas"

  fun validate(payload: String) {
    val node: JsonNode = jacksonObjectMapper().readTree(payload)
    val schemaPath = node.get("schema_path")?.asText()
      ?: throw SchemaValidationError("payload has no schema_path")
    val schema = load("$rootSchemaPath/$schemaPath")
    val errors = schema.validate(node)
    if (errors.isNotEmpty()) {
      throw SchemaValidationError("payload does not match <$schemaPath>: ${errors.joinToString("; ")}")
    }
  }

  private fun load(file: String): JsonSchema = cache.getOrPut(file) {
    JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V4).getSchema(File(file).readText())
  }
}
EOF

w libs/bus/src/main/kotlin/com/example/bus/models/BusMessage.kt <<'EOF'
package com.example.bus.models

import software.amazon.awssdk.services.sqs.model.Message

class BusMessage(message: Message) {
  val id: String = message.messageId()
  val payload: String = message.body()
}
EOF

w libs/bus/src/main/kotlin/com/example/bus/Result.kt <<'EOF'
package com.example.bus

open class BusException(description: String, cause: Throwable? = null) : Exception(description, cause)

sealed class Result {
  class Success : Result()
  class Failure(val error: BusException) : Result()
}
EOF

w services/pricing/src/main/kotlin/com/example/pricing/PublishOrderDecided.kt <<'EOF'
package com.example.pricing

import com.example.pricing.bus.Publisher
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

object PublishOrderDecided {
  private val json = Json { encodeDefaults = true }

  fun run(publisher: Publisher, orderId: String, tenantId: String, accepted: Boolean) {
    val message = OrderDecided(
      order_id = orderId,
      tenant_id = tenantId,
      outcome = if (accepted) OrderDecided.Outcome.ACCEPT else OrderDecided.Outcome.REJECT,
    )
    publisher.publish("orders-decided", json.encodeToString(message))
  }
}
EOF

w services/pricing/src/main/kotlin/com/example/pricing/OrderDecided.kt <<'EOF'
package com.example.pricing

import kotlinx.serialization.Serializable

// Generated from schemas/orders/v1/OrderDecided.json at build time; kept in
// the tree here so the fixture reads without a build.
@Serializable
data class OrderDecided(
  val schema_path: String = "orders/v1/OrderDecided.json",
  val order_id: String,
  val tenant_id: String,
  val outcome: Outcome,
) {
  @Serializable
  enum class Outcome { ACCEPT, REJECT }
}
EOF

for svc in pricing fulfillment notifications; do
  w services/$svc/Dockerfile <<EOF
FROM gradle:8-jdk17 AS build
WORKDIR /build
COPY libs/bus libs/bus
COPY services/$svc services/$svc
RUN gradle -p services/$svc installDist

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /build/services/$svc/build/install/$svc /app
# The bus library validates each message against these, relative to /app.
COPY schemas /app/schemas
CMD ["/app/bin/$svc"]
EOF
done

w services/fulfillment/src/main/kotlin/com/example/fulfillment/worker/OrderDecidedHandler.kt <<'EOF'
package com.example.fulfillment.worker

import com.example.bus.Result
import com.example.bus.handlers.BusHandler
import com.example.bus.models.BusMessage
import com.example.fulfillment.business.HandleOrderDecided
import kotlinx.serialization.json.Json
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

class OrderDecidedHandler(private val handleOrderDecided: HandleOrderDecided) : BusHandler {
  // Unknown keys are ignored, so a newer producer's extra fields decode fine.
  private val json = Json { ignoreUnknownKeys = true }

  override fun validate(message: BusMessage): Result = Result.Success()

  override fun handle(message: BusMessage): Result {
    val payload = json.decodeFromString(OrderDecided.serializer(), message.payload)
    logger.info { "Handling order decided ${payload.order_id}" }
    return handleOrderDecided.run(
      orderId = payload.order_id,
      tenantId = payload.tenant_id,
      accepted = payload.outcome == OrderDecided.Outcome.ACCEPT,
    ).fold({ Result.Failure(it) }, { Result.Success() })
  }
}
EOF

w services/fulfillment/src/main/kotlin/com/example/fulfillment/worker/OrderDecided.kt <<'EOF'
package com.example.fulfillment.worker

import kotlinx.serialization.Serializable

// Generated from schemas/orders/v1/OrderDecided.json at build time.
@Serializable
data class OrderDecided(
  val schema_path: String = "orders/v1/OrderDecided.json",
  val order_id: String,
  val tenant_id: String,
  val outcome: Outcome,
) {
  @Serializable
  enum class Outcome { ACCEPT, REJECT }
}
EOF

w services/fulfillment/src/main/kotlin/com/example/fulfillment/business/HandleOrderDecided.kt <<'EOF'
package com.example.fulfillment.business

import arrow.core.Either
import arrow.core.right
import com.example.bus.BusException

class HandleOrderDecided(private val shipments: Shipments) {
  fun run(orderId: String, tenantId: String, accepted: Boolean): Either<BusException, Unit> {
    if (accepted) shipments.schedule(orderId, tenantId) else shipments.cancel(orderId, tenantId)
    return Unit.right()
  }
}
EOF

w services/notifications/src/main/kotlin/com/example/notifications/handlers/OrderDecidedHandler.kt <<'EOF'
package com.example.notifications.handlers

import com.example.bus.Result
import com.example.bus.handlers.BusHandler
import com.example.bus.models.BusMessage
import com.example.notifications.Mailer
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue

class OrderDecidedHandler(private val mailer: Mailer) : BusHandler {
  private val mapper = jacksonObjectMapper()
    .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)

  override fun validate(message: BusMessage): Result = Result.Success()

  override fun handle(message: BusMessage): Result {
    val payload: OrderDecided = mapper.readValue(message.payload)
    mailer.orderDecided(payload.order_id, payload.tenant_id, payload.outcome)
    return Result.Success()
  }
}
EOF

w services/notifications/src/main/kotlin/com/example/notifications/handlers/OrderDecided.kt <<'EOF'
package com.example.notifications.handlers

// Generated from schemas/orders/v1/OrderDecided.json at build time.
data class OrderDecided(
  val schema_path: String = "orders/v1/OrderDecided.json",
  val order_id: String,
  val tenant_id: String,
  val outcome: Outcome,
) {
  enum class Outcome { ACCEPT, REJECT }
}
EOF

git add -A
git commit -q -m "orders: OrderDecided over the bus"
base=$(git rev-parse HEAD)
# The change is a feature branch off main, as a PR's is: a review of part of
# it can then tell what the rest of the branch changed.
git checkout -q -b feature

# ---------------------------------------------------------------- c1

python3 - <<'EOF'
import re
p = "schemas/orders/v1/OrderDecided.json"
s = open(p).read()
s = s.replace('''    "outcome": {
      "$ref": "#/definitions/Outcome"
    }
  },''', '''    "outcome": {
      "$ref": "#/definitions/Outcome"
    },
    "reason": {
      "description": "Why the order was decided. Optional; consumers treat a missing reason as PRICE_CHANGED. RECOUNT decisions only re-run a count, so fulfillment does not act on them.",
      "$ref": "#/definitions/Reason",
      "default": "PRICE_CHANGED"
    }
  },''')
s = s.replace('''      "enum": ["ACCEPT", "REJECT"]
    }
  }''', '''      "enum": ["ACCEPT", "REJECT"]
    },
    "Reason": {
      "type": "string",
      "enum": ["PRICE_CHANGED", "RECOUNT"]
    }
  }''')
open(p, "w").write(s)

for p, ser in [("services/pricing/src/main/kotlin/com/example/pricing/OrderDecided.kt", True),
               ("services/fulfillment/src/main/kotlin/com/example/fulfillment/worker/OrderDecided.kt", True),
               ("services/notifications/src/main/kotlin/com/example/notifications/handlers/OrderDecided.kt", False)]:
    s = open(p).read()
    s = s.replace("  val outcome: Outcome,\n) {", "  val outcome: Outcome,\n  val reason: Reason = Reason.PRICE_CHANGED,\n) {")
    tag = "  @Serializable\n" if ser else ""
    s = s.replace("  enum class Outcome { ACCEPT, REJECT }\n", "  enum class Outcome { ACCEPT, REJECT }\n\n" + tag + "  enum class Reason { PRICE_CHANGED, RECOUNT }\n")
    open(p, "w").write(s)

p = "services/pricing/src/main/kotlin/com/example/pricing/PublishOrderDecided.kt"
s = open(p).read()
s = s.replace("accepted: Boolean) {", "accepted: Boolean,\n          reason: OrderDecided.Reason = OrderDecided.Reason.PRICE_CHANGED) {")
s = s.replace("      outcome = if (accepted) OrderDecided.Outcome.ACCEPT else OrderDecided.Outcome.REJECT,\n",
              "      outcome = if (accepted) OrderDecided.Outcome.ACCEPT else OrderDecided.Outcome.REJECT,\n      reason = reason,\n")
open(p, "w").write(s)

p = "services/notifications/src/main/kotlin/com/example/notifications/handlers/OrderDecidedHandler.kt"
s = open(p).read()
s = s.replace("    val payload: OrderDecided = mapper.readValue(message.payload)\n",
              "    val payload: OrderDecided = mapper.readValue(message.payload)\n"
              "    // A recount changes nothing a customer sees.\n"
              "    if (payload.reason == OrderDecided.Reason.RECOUNT) return Result.Success()\n")
open(p, "w").write(s)
EOF
git add -A
git commit -q -m "orders: OrderDecided says why it was published"
c1=$(git rev-parse HEAD)

# ---------------------------------------------------------------- c2

python3 - <<'EOF'
p = "services/fulfillment/src/main/kotlin/com/example/fulfillment/worker/OrderDecidedHandler.kt"
s = open(p).read()
s = s.replace('''    logger.info { "Handling order decided ${payload.order_id}" }
''', '''    logger.info { "Handling order decided ${payload.order_id} (${payload.reason})" }
    // A recount only re-runs a count; scheduling again would ship twice.
    if (payload.reason == OrderDecided.Reason.RECOUNT) return Result.Success()
''')
open(p, "w").write(s)
EOF
git add -A
git commit -q -m "fulfillment: skip recount decisions"
c2=$(git rev-parse HEAD)

echo "base=$base c1=$c1 c2=$c2"
