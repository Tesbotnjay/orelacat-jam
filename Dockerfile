# OrelaCat Jam — Listen Together server
# Build stage
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server .

# Runtime stage
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=build /out/server /app/server
ENV PORT=8080
EXPOSE 8080
CMD ["/app/server"]
