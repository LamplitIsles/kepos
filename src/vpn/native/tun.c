/* Linux TUN packet adapter. The parent owns addresses/routes and this process. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/if.h>
#include <linux/if_tun.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define MTU 1400

static void nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
    perror("fcntl"); exit(1);
  }
}

int main(void) {
  int tun = open("/dev/net/tun", O_RDWR | O_CLOEXEC | O_NONBLOCK);
  if (tun < 0) { perror("open /dev/net/tun"); return 1; }
  struct ifreq req = {0};
  req.ifr_flags = IFF_TUN | IFF_NO_PI;
  memcpy(req.ifr_name, "kep%d", 6);
  if (ioctl(tun, TUNSETIFF, &req) < 0) { perror("TUNSETIFF (CAP_NET_ADMIN required)"); return 1; }
  size_t name_len = strnlen(req.ifr_name, IFNAMSIZ);
  if (write(3, req.ifr_name, name_len) != (ssize_t)name_len || write(3, "\n", 1) != 1) {
    perror("report interface"); return 1;
  }
  close(3);
  nonblock(STDIN_FILENO);
  nonblock(STDOUT_FILENO);
  uint8_t input[MTU + 2], output[MTU + 2];
  size_t in_have = 0, in_need = 2, out_have = 0, out_sent = 0;
  for (;;) {
    struct pollfd fds[3] = {
      { .fd = tun, .events = (out_have == 0 ? POLLIN : 0) | (in_have == in_need && in_need > 2 ? POLLOUT : 0) },
      { .fd = STDIN_FILENO, .events = in_have < in_need ? POLLIN : 0 },
      { .fd = STDOUT_FILENO, .events = out_have ? POLLOUT : 0 },
    };
    if (poll(fds, 3, -1) < 0) { if (errno == EINTR) continue; perror("poll"); return 1; }
    if (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL)) { fprintf(stderr, "TUN closed\n"); return 1; }
    if (fds[1].revents & (POLLHUP | POLLERR | POLLNVAL)) return 0;
    if (fds[2].revents & (POLLHUP | POLLERR | POLLNVAL)) return 0;
    if (fds[0].revents & POLLIN) {
      ssize_t n = read(tun, output + 2, MTU);
      if (n < 0 && errno != EAGAIN && errno != EINTR) { perror("read TUN"); return 1; }
      if (n > 0) { output[0] = (uint8_t)((unsigned)n >> 8); output[1] = (uint8_t)n; out_have = (size_t)n + 2; out_sent = 0; }
    }
    if (fds[2].revents & POLLOUT) {
      ssize_t n = write(STDOUT_FILENO, output + out_sent, out_have - out_sent);
      if (n < 0 && errno != EAGAIN && errno != EINTR) { perror("write stdout"); return 1; }
      if (n > 0) { out_sent += (size_t)n; if (out_sent == out_have) out_have = out_sent = 0; }
    }
    if (fds[1].revents & POLLIN) {
      ssize_t n = read(STDIN_FILENO, input + in_have, in_need - in_have);
      if (n == 0) return 0;
      if (n < 0 && errno != EAGAIN && errno != EINTR) { perror("read stdin"); return 1; }
      if (n > 0) in_have += (size_t)n;
      if (in_have == 2 && in_need == 2) {
        size_t length = ((size_t)input[0] << 8) | input[1];
        if (length < 20 || length > MTU) { fprintf(stderr, "invalid packet length\n"); return 1; }
        in_need = length + 2;
      }
    }
    if (fds[0].revents & POLLOUT) {
      ssize_t n = write(tun, input + 2, in_need - 2);
      if (n < 0 && errno != EAGAIN && errno != EINTR) { perror("write TUN"); return 1; }
      if (n >= 0 && (size_t)n != in_need - 2) { fprintf(stderr, "short TUN packet write\n"); return 1; }
      if (n > 0) { in_have = 0; in_need = 2; }
    }
  }
}
