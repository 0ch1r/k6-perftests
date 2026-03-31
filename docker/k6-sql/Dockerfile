ARG GOLANG_IMAGE=golang:1.25.4-alpine3.22
ARG ALPINE_IMAGE=alpine:3.20.9

FROM ${GOLANG_IMAGE} AS builder
ARG XK6_VERSION=v1.2.6
ARG XK6_SQL_VERSION=v1.0.6
ARG XK6_SQL_DRIVER_MYSQL_VERSION=v0.2.2
ARG XK6_SQL_DRIVER_POSTGRES_VERSION=v0.1.1
ENV GOTOOLCHAIN=auto

RUN apk add --no-cache git
RUN go install go.k6.io/xk6/cmd/xk6@${XK6_VERSION}
RUN /go/bin/xk6 build \
  --output /tmp/k6 \
  --with github.com/grafana/xk6-sql@${XK6_SQL_VERSION} \
  --with github.com/grafana/xk6-sql-driver-mysql@${XK6_SQL_DRIVER_MYSQL_VERSION} \
  --with github.com/grafana/xk6-sql-driver-postgres@${XK6_SQL_DRIVER_POSTGRES_VERSION}

FROM ${ALPINE_IMAGE}

RUN apk add --no-cache ca-certificates
COPY --from=builder /tmp/k6 /usr/bin/k6

ENTRYPOINT ["k6"]
