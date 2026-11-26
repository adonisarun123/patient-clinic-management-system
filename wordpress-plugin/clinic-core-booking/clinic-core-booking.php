<?php
/**
 * Plugin Name:       Clinic Core Booking
 * Description:       Embeds the Clinic Core appointment booking widget. Use the [clinic_booking] shortcode or the settings page defaults.
 * Version:           0.1.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Monk Mantra
 * License:           Proprietary
 * Text Domain:       clinic-core-booking
 */

if (!defined('ABSPATH')) { exit; }

const CCB_OPTION = 'clinic_core_booking';

function ccb_settings() {
    $defaults = array('host' => '', 'clinic' => '', 'key' => '', 'min_height' => 560);
    return wp_parse_args(get_option(CCB_OPTION, array()), $defaults);
}

/**
 * [clinic_booking clinic="slug" key="pk_..." host="https://clinic-core.example.com" min_height="560"]
 * Attributes override the defaults saved under Settings → Clinic Core Booking.
 */
function ccb_shortcode($atts) {
    $s = ccb_settings();
    $a = shortcode_atts(array(
        'clinic' => $s['clinic'], 'key' => $s['key'], 'host' => $s['host'], 'min_height' => $s['min_height'],
    ), $atts, 'clinic_booking');

    $host = untrailingslashit(esc_url_raw($a['host']));
    if (!$host || !$a['clinic'] || !preg_match('/^pk_[A-Za-z0-9_-]{20,}$/', $a['key'])) {
        return current_user_can('manage_options')
            ? '<p style="color:#b91c1c">Clinic Core Booking: set host, clinic and publishable key (Settings → Clinic Core Booking).</p>'
            : '';
    }
    static $n = 0; $n++;
    $id = 'clinic-booking-' . $n;
    // The loader is idempotent, so several shortcodes on one page each get their own iframe.
    return sprintf(
        '<div id="%1$s"></div><script src="%2$s/embed.js" data-clinic="%3$s" data-key="%4$s" data-target="#%1$s" data-min-height="%5$d" async></script>',
        esc_attr($id), esc_url($host), esc_attr($a['clinic']), esc_attr($a['key']), absint($a['min_height'])
    );
}
add_shortcode('clinic_booking', 'ccb_shortcode');

// ------------------------------------------------------------------ settings page
add_action('admin_menu', function () {
    add_options_page('Clinic Core Booking', 'Clinic Core Booking', 'manage_options', 'clinic-core-booking', 'ccb_settings_page');
});

add_action('admin_init', function () {
    register_setting('ccb', CCB_OPTION, array('sanitize_callback' => function ($in) {
        return array(
            'host'       => untrailingslashit(esc_url_raw($in['host'] ?? '')),
            'clinic'     => sanitize_title($in['clinic'] ?? ''),
            'key'        => preg_replace('/[^A-Za-z0-9_-]/', '', $in['key'] ?? ''),
            'min_height' => max(300, absint($in['min_height'] ?? 560)),
        );
    }));
});

function ccb_settings_page() {
    $s = ccb_settings(); ?>
    <div class="wrap">
      <h1>Clinic Core Booking</h1>
      <p>Enter the values from Clinic Core → Settings → Website &amp; integrations. Only ever use a <strong>publishable</strong> key (starts with <code>pk_</code>) here — never a secret key.</p>
      <form method="post" action="options.php">
        <?php settings_fields('ccb'); ?>
        <table class="form-table" role="presentation">
          <tr><th scope="row"><label for="ccb-host">Clinic Core URL</label></th>
              <td><input id="ccb-host" class="regular-text" name="<?php echo CCB_OPTION; ?>[host]" value="<?php echo esc_attr($s['host']); ?>" placeholder="https://clinic-core.example.com"></td></tr>
          <tr><th scope="row"><label for="ccb-clinic">Clinic slug</label></th>
              <td><input id="ccb-clinic" class="regular-text" name="<?php echo CCB_OPTION; ?>[clinic]" value="<?php echo esc_attr($s['clinic']); ?>"></td></tr>
          <tr><th scope="row"><label for="ccb-key">Publishable key</label></th>
              <td><input id="ccb-key" class="regular-text" name="<?php echo CCB_OPTION; ?>[key]" value="<?php echo esc_attr($s['key']); ?>" placeholder="pk_..."></td></tr>
          <tr><th scope="row"><label for="ccb-h">Minimum height (px)</label></th>
              <td><input id="ccb-h" type="number" min="300" name="<?php echo CCB_OPTION; ?>[min_height]" value="<?php echo esc_attr($s['min_height']); ?>"></td></tr>
        </table>
        <?php submit_button(); ?>
      </form>
      <p>Then place <code>[clinic_booking]</code> on any page or post (or in an Elementor/Gutenberg shortcode block).</p>
      <p>Also add this site's address (e.g. <code><?php echo esc_html(home_url()); ?></code>) to the key's allowed websites in Clinic Core, or the widget will refuse to load here.</p>
    </div>
<?php }
