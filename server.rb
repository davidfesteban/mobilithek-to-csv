require "base64"
require "json"
require "net/http"
require "openssl"
require "stringio"
require "uri"
require "webrick"
require "zlib"

HOST = ENV.fetch("HOST", "127.0.0.1")
PORT = Integer(ENV.fetch("PORT", "5173"))
ROOT = File.expand_path(__dir__)
MAX_BODY_BYTES = 25 * 1024 * 1024

unless Net::HTTP::SSL_ATTRIBUTES.include?(:extra_chain_cert)
  class Net::HTTP
    attr_accessor :extra_chain_cert unless instance_methods.include?(:extra_chain_cert=)
  end

  Net::HTTP::SSL_IVNAMES << :@extra_chain_cert unless Net::HTTP::SSL_IVNAMES.include?(:@extra_chain_cert)
  Net::HTTP::SSL_ATTRIBUTES << :extra_chain_cert
end

def allowed_origin?(origin)
  return false if origin.nil? || origin.empty?
  return true if origin == "null"

  uri = URI(origin)
  return false unless uri.scheme == "http"
  return false unless uri.port == PORT
  %w[127.0.0.1 localhost].include?(uri.host)
rescue StandardError
  false
end

def set_cors(req, res)
  origin = req.header["origin"]&.first
  if allowed_origin?(origin)
    res["Access-Control-Allow-Origin"] = origin
    res["Vary"] = "Origin"
  end
  res["Access-Control-Allow-Methods"] = "POST, OPTIONS"
  res["Access-Control-Allow-Headers"] = "Content-Type"
  res["Access-Control-Max-Age"] = "600"
end

def send_json(res, status, payload)
  body = JSON.generate(payload)
  res.status = status
  res["Content-Type"] = "application/json; charset=utf-8"
  res["Cache-Control"] = "no-store"
  res.body = body
end

def fetch_with_client_cert(endpoint, pfx_bytes, passphrase)
  uri = URI(endpoint)
  raise "Endpoint must be https://" unless uri.is_a?(URI::HTTPS)

  pkcs12 = OpenSSL::PKCS12.new(pfx_bytes, passphrase)

  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = true
  http.verify_mode = OpenSSL::SSL::VERIFY_PEER
  http.cert = pkcs12.certificate
  http.key = pkcs12.key
  http.extra_chain_cert = pkcs12.ca_certs if pkcs12.ca_certs && !pkcs12.ca_certs.empty?
  http.open_timeout = 20
  http.read_timeout = 60

  req = Net::HTTP::Get.new(
    uri.request_uri,
    {
      "Accept" => "application/xml,text/xml,application/xhtml+xml,text/plain,*/*",
      "Accept-Encoding" => "gzip,deflate",
      "User-Agent" => "mobilithek-to-csv-local/1.0"
    }
  )

  res = http.request(req)
  body = (res.body || +"").dup
  body.force_encoding(Encoding::BINARY)

  encoding = (res["content-encoding"] || "").downcase
  if encoding.include?("gzip")
    body = Zlib::GzipReader.new(StringIO.new(body)).read
  elsif encoding.include?("deflate")
    body = Zlib::Inflate.inflate(body)
  end

  text = body.encode("UTF-8", invalid: :replace, undef: :replace, replace: "\uFFFD")

  {
    ok: res.code.to_i >= 200 && res.code.to_i < 300,
    upstreamStatus: res.code.to_i,
    upstreamStatusText: res.message.to_s,
    contentType: res["content-type"].to_s,
    text: text
  }
end

server = WEBrick::HTTPServer.new(
  BindAddress: HOST,
  Port: PORT,
  AccessLog: [],
  Logger: WEBrick::Log.new($stderr, WEBrick::Log::INFO),
  DoNotReverseLookup: true
)

server.mount_proc("/api/fetch") do |req, res|
  set_cors(req, res)

  if req.request_method == "OPTIONS"
    res.status = 204
    res.body = ""
    next
  end

  unless req.request_method == "POST"
    send_json(res, 405, { error: "Method not allowed." })
    next
  end

  content_type = (req["content-type"] || "").downcase
  unless content_type.include?("application/json")
    send_json(res, 415, { error: "Content-Type must be application/json." })
    next
  end

  if req.body && req.body.bytesize > MAX_BODY_BYTES
    send_json(res, 413, { error: "Request body too large." })
    next
  end

  payload = JSON.parse(req.body.to_s)
  endpoint = payload["endpoint"].to_s.strip
  p12_base64 = payload["p12Base64"].to_s.strip
  passphrase = payload["passphrase"].to_s

  if endpoint.empty?
    send_json(res, 400, { error: "Missing endpoint." })
    next
  end
  unless endpoint.start_with?("https://")
    send_json(res, 400, { error: "Endpoint must start with https://." })
    next
  end
  if p12_base64.empty?
    send_json(res, 400, { error: "Missing p12Base64." })
    next
  end

  pfx = Base64.decode64(p12_base64)
  if pfx.nil? || pfx.empty?
    send_json(res, 400, { error: "Invalid certificate (empty after base64 decode)." })
    next
  end

  upstream = fetch_with_client_cert(endpoint, pfx, passphrase)
  send_json(res, 200, upstream)
rescue OpenSSL::PKCS12::PKCS12Error => e
  send_json(res, 400, { error: "PKCS12 error: #{e.message}" })
rescue JSON::ParserError
  send_json(res, 400, { error: "Invalid JSON." })
rescue StandardError => e
  send_json(res, 500, { error: e.message })
end

server.mount("/", WEBrick::HTTPServlet::FileHandler, ROOT, FancyIndexing: false)

trap("INT") { server.shutdown }
trap("TERM") { server.shutdown }

puts "Server running: http://#{HOST}:#{PORT}"
puts "Open it in your browser, then select the .p12 + passphrase and click “Try fetch”."

server.start
