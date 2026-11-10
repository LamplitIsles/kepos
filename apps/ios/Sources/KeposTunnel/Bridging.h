#import <BareKit/bare-kit.h>

// iPhoneOS does not ship net/route.h. These are the routing-message ABI
// declarations used by Darwin's NET_RT_DUMP (see xnu bsd/net/route.h).
// The provider rejects unexpected versions, lengths, and failed sysctl calls;
// availability inside a signed iOS extension still requires device testing.
#include <stdint.h>
struct rt_metrics {
    uint32_t rmx_locks, rmx_mtu, rmx_hopcount;
    int32_t rmx_expire;
    uint32_t rmx_recvpipe, rmx_sendpipe, rmx_ssthresh, rmx_rtt, rmx_rttvar, rmx_pksent;
    uint32_t rmx_filler[4];
};
struct rt_msghdr {
    uint16_t rtm_msglen;
    uint8_t rtm_version, rtm_type;
    uint16_t rtm_index;
    int32_t rtm_flags, rtm_addrs, rtm_pid, rtm_seq, rtm_errno, rtm_use;
    uint32_t rtm_inits;
    struct rt_metrics rtm_rmx;
};
#define RTM_VERSION 5
#define RTA_DST 0x1
#define RTF_UP 0x1
#define RTF_HOST 0x4
#define RTF_LLINFO 0x400
#define RTF_WASCLONED 0x20000
